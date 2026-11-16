import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ApiError, Store } from '../src/store.js'
import { IdentitySessions, XcodexProvider, externalUserId, type IdentityGrant, type IdentityProvider } from '../src/xcodex-auth.js'
const issuer='https://xcodex.example', supabase='https://identity.example', subject=randomUUID()
const user={id:subject,email:'alice@example.com'}
const grant=():IdentityGrant=>({issuer,subject,email:user.email,provider:'local',token:'upstream-private-token',expiresAt:Date.now()+86400000})
const dirs:string[]=[],sessions:IdentitySessions[]=[]
afterEach(()=>{for(const s of sessions.splice(0))s.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});vi.restoreAllMocks();vi.useRealTimers()})
function fixture(){const dir=mkdtempSync(join(tmpdir(),'remote-identity-'));dirs.push(dir);const file=join(dir,'state.json');return {file,store:new Store(file,'admin@example.com','legacy-password-123')}}
const device=()=>({deviceId:randomUUID(),identityKey:Buffer.alloc(32,1).toString('base64url'),name:'device',role:'client' as const,platform:'linux',clientVersion:'0.6.4'})
function provider(routes:(url:string,init:RequestInit)=>[number,unknown]){
 const calls:{url:string,init:RequestInit}[]=[]
 const request=vi.fn(async(input: string|URL|Request,init:RequestInit={})=>{const url=String(input);calls.push({url,init});const [status,data]=routes(url,init);return new Response(JSON.stringify(data),{status})}) as typeof fetch
 return {auth:new XcodexProvider(issuer,supabase,request),calls}
}
const config={local_auth:true,supabase:{enabled:true,url:supabase,publishable_key:'public-key'}}
describe('xcodex identity adapter',()=>{
 it('uses local login then verified portal identity, never token claims or email as owner',async()=>{
  const {auth,calls}=provider(url=>url.endsWith('/config')?[200,config]:url.endsWith('/auth/login')?[200,{token:'local_'+'a'.repeat(64)}]:[200,user])
  const result=await auth.login('alice@example.com','test-password')
  expect(result.subject).toBe(subject);expect(result.provider).toBe('local');expect(calls.map(c=>c.url)).toEqual([issuer+'/api/portal/config',issuer+'/api/portal/auth/login',issuer+'/api/portal/me'])
  expect(calls.every(c=>c.init.redirect==='error')).toBe(true)
 })
 it('uses legacy password grant only after the precise non-local account response',async()=>{
  const {auth,calls}=provider(url=>url.endsWith('/config')?[200,config]:url.endsWith('/auth/login')?[404,{error:'该邮箱不是本地账户'}]:url.includes('/token?')?[200,{access_token:'legacy-token',refresh_token:'legacy-refresh',expires_in:3600}]:[200,user])
  expect((await auth.login('alice@example.com','test-password')).provider).toBe('supabase')
  expect(calls.find(c=>c.url.includes('/token?'))?.url).toBe(supabase+'/auth/v1/token?grant_type=password')
 })
 it.each([
  [401,{error:'邮箱或密码不正确'},'AUTH_INVALID'],[404,{error:'接口不存在'},'AUTH_SERVICE_UNAVAILABLE'],
  [503,{error:'upstream detail'},'AUTH_SERVICE_UNAVAILABLE'],[429,{},'RATE_LIMITED'],
  [403,{error:'计费账户未启用'},'ACCOUNT_DISABLED'],[403,{error:'请先完成邮箱验证'},'EMAIL_NOT_VERIFIED'],
  [403,{error:'unknown restriction'},'AUTH_ACCESS_DENIED'],[409,{},'ACCOUNT_IDENTITY_CONFLICT'],
 ])('preserves failure category and never falls back: %s %j',async(status,body,code)=>{
  const {auth,calls}=provider(url=>url.endsWith('/config')?[200,config]:[status as number,body])
  await expect(auth.login('alice@example.com','test-password')).rejects.toMatchObject({code})
  expect(calls.some(c=>c.url.startsWith(supabase))).toBe(false)
 })
 it('pins the Supabase destination before forwarding any password',async()=>{
  const {auth,calls}=provider(()=>[200,{...config,supabase:{...config.supabase,url:'https://attacker.example'}}])
  await expect(auth.login('alice@example.com','test-password')).rejects.toMatchObject({code:'AUTH_SERVICE_UNAVAILABLE'})
  expect(calls).toHaveLength(1)
 })
 it('rejects invalid or changed subject, and refreshes Supabase using its refresh credential',async()=>{
  const {auth,calls}=provider(url=>url.endsWith('/config')?[200,config]:url.includes('/token?')?[200,{access_token:'new-access',refresh_token:'new-refresh',expires_in:3600}]:[200,user])
  const result=await auth.verify({...grant(),provider:'supabase',refreshToken:'old-refresh',expiresAt:Date.now()-1})
  expect(result.token).toBe('new-access');expect(result.refreshToken).toBe('new-refresh')
  expect(JSON.parse(calls.find(c=>c.url.includes('/token?'))!.init.body as string)).toEqual({refresh_token:'old-refresh'})
  await expect(auth.verify({...grant(),subject:randomUUID()})).rejects.toMatchObject({code:'ACCOUNT_IDENTITY_CONFLICT'})
  await expect(auth.verify({...grant(),expiresAt:Date.now()-1})).rejects.toMatchObject({code:'REAUTH_REQUIRED'})
 })
})
describe('encrypted credential lifecycle and tenant storage',()=>{
 it('stores only encrypted upstream grants, survives restart and rejects wrong encryption key',async()=>{
  const {file,store}=fixture();const api:IdentityProvider={login:async()=>grant(),verify:async g=>g}
  const manager=new IdentitySessions(store,api,'a'.repeat(64));sessions.push(manager)
  const id=await manager.login(user.email,'password-not-persisted')
  const raw=readFileSync(file,'utf8');expect(raw).not.toContain('upstream-private-token');expect(raw).not.toContain('password-not-persisted')
  expect(()=>new IdentitySessions(store,api,'b'.repeat(64))).toThrow('AUTH_SERVICE_UNAVAILABLE')
  const next=new IdentitySessions(new Store(file,'admin@example.com','legacy-password-123'),api,'a'.repeat(64));sessions.push(next)
  await next.ensure(id);expect(()=>next.requireCached(id)).not.toThrow()
 })
 it('rejects cross-user registration and preserves both users over legacy password changes',()=>{
  const {file,store}=fixture(),a=externalUserId(grant()),b=externalUserId({...grant(),subject:randomUUID()})
  store.setUser(a,user.email,'encrypted-a');store.setUser(b,'b@example.com','encrypted-b')
  const d=device(),access=store.register(d,a);expect(()=>store.register(d,b)).toThrow('DEVICE_NOT_FOUND')
  expect(store.list(b)).toEqual([]);expect(()=>store.owned(d.deviceId,b)).toThrow('DEVICE_NOT_FOUND')
  const next=new Store(file,'admin@example.com','different-legacy-password');expect(next.authenticate(access.accessToken).ownerId).toBe(a)
 })
 it('migrates v1 without reassigning legacy devices and keeps an exact recovery copy',()=>{
  const {file,store}=fixture(),d=device(),tokens=store.register(d)
  const v1=JSON.parse(readFileSync(file,'utf8'));v1.version=1;delete v1.users;for(const d of Object.values(v1.devices) as any[])delete d.ownerId
  const raw=JSON.stringify(v1);writeFileSync(file,raw)
  const next=new Store(file,'admin@example.com','legacy-password-123')
  expect(next.authenticate(tokens.accessToken).ownerId).toBe(next.legacyUserId)
  expect(readFileSync(file+'.v1-backup','utf8')).toBe(raw)
  expect(next.refresh(d.deviceId,tokens.refreshToken).accessToken).toBeTruthy()
 })
 it('fails closed on outage without deleting credentials, but revokes them on confirmed disable',async()=>{
  const {store}=fixture();let error:ApiError|undefined
  const api:IdentityProvider={login:async()=>grant(),verify:async g=>{if(error)throw error;return g}}
  const manager=new IdentitySessions(store,api,'a'.repeat(64));sessions.push(manager)
  const id=await manager.login(user.email,'password'),d=device(),token=store.register(d,id)
  error=new ApiError('AUTH_SERVICE_UNAVAILABLE',503)
  await expect(manager.ensure(id,true)).rejects.toMatchObject({code:error.code})
  expect(()=>manager.requireCached(id)).toThrow(error.code);expect(store.authenticate(token.accessToken).ownerId).toBe(id)
  error=undefined;await manager.ensure(id,true)
  error=new ApiError('ACCOUNT_DISABLED',403)
  await expect(manager.ensure(id,true)).rejects.toMatchObject({code:error.code})
  expect(()=>store.authenticate(token.accessToken)).toThrow('AUTH_INVALID')
 })

 it('persists a rotated upstream refresh token before a retryable profile lookup failure',async()=>{
  const {store}=fixture();let failMe=false, refreshCalls=0
  const {auth}=provider(url=>{
   if(url.endsWith('/config'))return [200,config]
   if(url.endsWith('/auth/login'))return [404,{error:'该邮箱不是本地账户'}]
   if(url.includes('grant_type=password'))return [200,{access_token:'original-access',refresh_token:'original-refresh',expires_in:30}]
   if(url.includes('grant_type=refresh_token')){refreshCalls++;return [200,{access_token:'rotated-access',refresh_token:'rotated-refresh',expires_in:3600}]}
   return failMe?[503,{}]:[200,user]
  })
  const manager=new IdentitySessions(store,auth,'a'.repeat(64));sessions.push(manager)
  const id=await manager.login(user.email,'password');failMe=true
  await expect(manager.ensure(id,true)).rejects.toMatchObject({code:'AUTH_SERVICE_UNAVAILABLE'})
  failMe=false;await manager.ensure(id,true)
  expect(refreshCalls).toBe(1);expect(()=>manager.requireCached(id)).not.toThrow()
 })
 it('deduplicates verification and ignores stale failure after a new successful login',async()=>{
  const {store}=fixture();let reject!:(e:Error)=>void
  const verify=vi.fn(()=>new Promise<IdentityGrant>((_,r)=>reject=r))
  const api:IdentityProvider={login:async()=>grant(),verify}
  const manager=new IdentitySessions(store,api,'a'.repeat(64));sessions.push(manager)
  const id=await manager.login(user.email,'password'),d=device(),token=store.register(d,id)
  const p=manager.ensure(id,true),p2=manager.ensure(id,true);expect(p).toBe(p2)
  await manager.login(user.email,'password');reject(new ApiError('ACCOUNT_DISABLED',403));await p
  expect(()=>manager.requireCached(id)).not.toThrow();expect(store.authenticate(token.accessToken).ownerId).toBe(id);expect(verify).toHaveBeenCalledTimes(1)
 })
})

it('exchanges browser Google/OTP/password credentials through the pinned Supabase then portal identity',async()=>{
 const {auth,calls}=provider(url=>url.endsWith('/config')?[200,config]:url.endsWith('/me')?[200,user]:url.endsWith('/otp')?[200,{}]:[200,{access_token:'supabase-access',refresh_token:'supabase-refresh',expires_in:3600}])
 const redirect='https://remote.example/api/v1/auth/supabase/callback?remote_state=nonce'
 const url=new URL(await auth.oauthUrl(redirect,'challenge'))
 expect(url.origin).toBe(supabase);expect(url.searchParams.get('provider')).toBe('google');expect(url.searchParams.get('redirect_to')).toBe(redirect);expect(url.searchParams.get('code_challenge_method')).toBe('s256')
 expect((await auth.oauthExchange('code','verifier')).subject).toBe(subject)
 expect(JSON.parse(calls.find(c=>c.url.includes('grant_type=pkce'))!.init.body as string)).toEqual({auth_code:'code',code_verifier:'verifier'})
 await auth.sendOtp(user.email)
 expect(JSON.parse(calls.find(c=>c.url.endsWith('/otp'))!.init.body as string)).toEqual({email:user.email,create_user:false})
 expect((await auth.verifyOtp(user.email,'123456')).subject).toBe(subject)
 expect((await auth.passwordLogin(user.email,'test-password')).subject).toBe(subject)
 expect(calls.filter(c=>c.url.endsWith('/me'))).toHaveLength(3)
 expect(calls.some(c=>c.url.endsWith('/auth/login'))).toBe(false)
})
it('does not accept a successful Supabase login if the portal rejects the account',async()=>{
 const {auth}=provider(url=>url.endsWith('/config')?[200,config]:url.endsWith('/me')?[403,{error:'计费账户未启用'}]:[200,{access_token:'access',refresh_token:'refresh',expires_in:3600}])
 await expect(auth.verifyOtp(user.email,'123456')).rejects.toMatchObject({code:'ACCOUNT_DISABLED'})
})

it('reports expired email codes as invalid login credentials, not account disablement',async()=>{
 const {auth}=provider(url=>url.endsWith('/config')?[200,config]:[403,{error_code:'otp_expired'}])
 await expect(auth.verifyOtp(user.email,'123456')).rejects.toMatchObject({code:'AUTH_INVALID',status:401})
})
