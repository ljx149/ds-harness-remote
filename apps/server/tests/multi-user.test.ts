import { HostServerApi, ClientServerApi } from '../../../packages/plugin/src/server-api.js'
import { ServerCredentialStore } from '../../../packages/plugin/src/server-credentials.js'
import { generateKeyPair } from '../../../packages/crypto/src/index.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { createControlFrame } from '@dsh-remote/protocol'
import { createRemoteServer } from '../src/server.js'
import { ApiError } from '../src/store.js'
import type { IdentityProvider } from '../src/xcodex-auth.js'
let app:ReturnType<typeof createRemoteServer>,base:string,dir:string
const sockets:WebSocket[]=[]
const a=randomUUID(),b=randomUUID()
let disabledSubject:string|undefined
const provider:IdentityProvider={
 login:async(email,password)=>{if(password!=='test-password')throw new ApiError('AUTH_INVALID',401);return {issuer:'https://xcodex.example',subject:email==='a@example.com'?a:b,email,provider:'local',token:'upstream-'+email,expiresAt:Date.now()+3600000}},
 verify:async grant=>{if(grant.subject===disabledSubject)throw new ApiError('ACCOUNT_DISABLED',403);return grant},
}
async function start(){app=createRemoteServer({account:'admin@example.com',password:'legacy-password-123',dataFile:join(dir,'state.json'),publicUrl:'https://remote.example',authMode:'xcodex',identityProvider:provider,xcodexCredentialKey:'a'.repeat(64),logLevel:'silent'});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base=`http://127.0.0.1:${(app.server.address() as any).port}`}
beforeEach(async()=>{disabledSubject=undefined;dir=mkdtempSync(join(tmpdir(),'remote-tenants-'));await start()})
afterEach(async()=>{vi.restoreAllMocks();for(const s of sockets.splice(0))s.terminate();await app.close();rmSync(dir,{recursive:true,force:true})})
async function api(path:string,token?:string,body?:unknown,method=body===undefined?'GET':'POST'){
 const r=await fetch(base+'/api/v1'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json() as any}
}
async function login(email:string){const r=await api('/auth/login',undefined,{email,password:'test-password'});expect(r.status).toBe(200);return r.data}
async function device(token:string,role:'client'|'host'){
 const d={deviceId:randomUUID(),identityKey:Buffer.alloc(32,role==='host'?1:2).toString('base64url'),name:'fixture-device',role,platform:'linux',clientVersion:'0.6.4'}
 const r=await api('/devices/register',token,{v:1,device:d});expect(r.status).toBe(200);return {...d,...r.data}
}
class Wire{
 messages:any[]=[]
 constructor(readonly ws:WebSocket){ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.type==='ping')this.send('pong',{nonce:m.payload.nonce});else this.messages.push(m)})}
 send(type:Parameters<typeof createControlFrame>[0],payload:unknown){this.ws.send(JSON.stringify(createControlFrame(type,payload)))}
 async next(type:string){for(let i=0;i<100;i++){const n=this.messages.findIndex(m=>m.type===type);if(n>=0)return this.messages.splice(n,1)[0].payload;await new Promise(r=>setTimeout(r,20))}throw Error('missing '+type)}
}
async function socket(d:any){const ws=new WebSocket(base.replace('http:','ws:')+'/ws/v1/connect');sockets.push(ws);const w=new Wire(ws);await once(ws,'open');w.send('hello',{role:d.role,deviceId:d.deviceId,accessToken:d.accessToken,protocols:[1],capabilities:['transport.relay'],clientVersion:d.clientVersion});await w.next('hello.ack');return w}
it('isolates lists, direct lookup, rename, registration and opposite-role delegation',async()=>{
 const ua=await login('a@example.com'),ub=await login('b@example.com');expect(ua.userId).not.toBe(ub.userId)
 const ha=await device(ua.token,'host'),ca=await device(ua.token,'client'),cb=await device(ub.token,'client')
 expect((await api('/devices',ca.accessToken)).data.items.map((d:any)=>d.deviceId)).toEqual([ha.deviceId])
 expect((await api('/devices',cb.accessToken)).data.items).toEqual([])
 expect((await api('/account/devices',ub.token)).data.items.map((d:any)=>d.deviceId)).toEqual([cb.deviceId])
 for(const suffix of ['', '/presence'])expect((await api('/devices/'+ha.deviceId+suffix,cb.accessToken)).status).toBe(404)
 expect((await api('/devices/'+ha.deviceId+'/name',ub.token,{name:'hijack'})).status).toBe(404)
 const {deviceId,identityKey,name,role,platform,clientVersion}=ha
 expect((await api('/devices/register',ub.token,{v:1,device:{deviceId,identityKey,name,role,platform,clientVersion}})).status).toBe(404)
 expect((await api('/devices/register-owned-role',cb.accessToken,{v:1,device:{deviceId,identityKey,name,role,platform,clientVersion}})).status).toBe(404)
 expect((await api('/auth/refresh',undefined,{deviceId:ha.deviceId,refreshToken:cb.refreshToken})).status).toBe(401)
 expect((await api('/devices/'+ha.deviceId,ca.accessToken)).status).toBe(200)
 expect((await api('/auth/login',undefined,{email:'admin@example.com',password:'legacy-password-123'})).status).toBe(401)
})
it('allows same-user connection and blocks cross-user connect and relay guessing',async()=>{
 const ua=await login('a@example.com'),ub=await login('b@example.com')
 const ha=await device(ua.token,'host'),ca=await device(ua.token,'client'),cb=await device(ub.token,'client')
 const host=await socket(ha),client=await socket(ca),attacker=await socket(cb)
 attacker.send('connect.request',{hostDeviceId:ha.deviceId,preferredTransports:['relay']});expect((await attacker.next('error')).code).toBe('DEVICE_NOT_FOUND');expect(host.messages).toEqual([])
 client.send('connect.request',{hostDeviceId:ha.deviceId,preferredTransports:['relay']});const incoming=await host.next('connect.incoming');host.send('connect.accepted',{connectionId:incoming.connectionId});expect((await client.next('connect.accepted')).connectionId).toBe(incoming.connectionId)
 const attacker2=await socket(cb);attacker2.send('relay',{connectionId:incoming.connectionId,targetDeviceId:ha.deviceId,counter:0,ciphertext:'AQIDBA'});expect((await attacker2.next('error')).code).toBe('CONNECTION_NOT_FOUND')
 host.send('ping',{nonce:'still-online'});expect((await host.next('pong')).nonce).toBe('still-online')
})
it('keeps device ownership over restart, rotates tokens and distinguishes logout from device revoke',async()=>{
 const user=await login('a@example.com'),d=await device(user.token,'client')
 expect((await api('/auth/logout',user.token,{})).status).toBe(200)
 expect((await api('/account/devices',user.token)).status).toBe(401)
 expect((await api('/me',d.accessToken)).status).toBe(200)
 await app.close();await start()
 const rotated=await api('/auth/refresh',undefined,{deviceId:d.deviceId,refreshToken:d.refreshToken});expect(rotated.status).toBe(200)
 expect((await api('/me',rotated.data.accessToken)).status).toBe(200)
 expect((await login('a@example.com')).userId).toBe(user.userId)
 expect((await api('/devices/self',rotated.data.accessToken,undefined,'DELETE')).status).toBe(200)
 expect((await api('/auth/refresh',undefined,{deviceId:d.deviceId,refreshToken:rotated.data.refreshToken})).status).toBe(401)
})

it('revokes the disabled user and live connections without affecting another user',async()=>{
 const ua=await login('a@example.com'),ub=await login('b@example.com')
 const ha=await device(ua.token,'host'),hb=await device(ub.token,'host');await socket(ha);const other=await socket(hb)
 disabledSubject=a
 const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+61000)
 expect((await api('/auth/me',ua.token)).data.error.code).toBe('ACCOUNT_DISABLED')
 expect(app.gateway.peers.has(ha.deviceId)).toBe(false)
 expect((await api('/auth/refresh',undefined,{deviceId:ha.deviceId,refreshToken:ha.refreshToken})).status).toBe(401)
 expect((await api('/auth/me',ub.token)).status).toBe(200)
 other.send('ping',{nonce:'other-user-still-online'});expect((await other.next('pong')).nonce).toBe('other-user-still-online')
 expect((await api('/account/devices',ub.token)).data.items).toHaveLength(1)
})

it('accepts the existing PC plugin and client API login/register/discovery without protocol changes',async()=>{
 const host=new HostServerApi(base,new ServerCredentialStore(join(dir,'plugin-host')))
 const client=new ClientServerApi(base,new ServerCredentialStore(join(dir,'plugin-client')))
 const other=new ClientServerApi(base,new ServerCredentialStore(join(dir,'plugin-other')))
 const identity=()=>({schemaVersion:1 as const,deviceId:randomUUID(),name:'Integration PC',fingerprint:'fixture',...generateKeyPair()})
 const hostIdentity=identity()
 try {
  await host.authorizeWithAccount(hostIdentity,'a@example.com','test-password')
  await client.authorizeWithAccount(identity(),'a@example.com','test-password')
  await other.authorizeWithAccount(identity(),'b@example.com','test-password')
  expect((await client.listDevices()).map(d=>d.deviceId)).toEqual([hostIdentity.deviceId])
  expect(await other.listDevices()).toEqual([])
  await host.revokeCurrentDevice()
  expect(await client.listDevices()).toEqual([])
 } finally {host.close();client.close();other.close()}
})

it('hands browser identity to the real Plugin API, recovers lost exchange responses and persists device credentials', async () => {
  const user = await login('a@example.com')
  const hostIdentity = { schemaVersion: 1 as const, deviceId: randomUUID(), name: 'browser-login-host', fingerprint: 'fixture', ...generateKeyPair() }
  let dropExchange = true
  const nativeFetch: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    const response = await fetch(base + path, init)
    if (path === '/api/v1/auth/device/exchange' && dropExchange) { dropExchange = false; await response.text(); throw Error('simulated lost response') }
    return response
  }
  const credentials = new ServerCredentialStore(join(dir, 'browser-host'))
  const native = new HostServerApi('https://remote.example', credentials, nativeFetch)
  const flow = await native.startBrowserLogin(hostIdentity)
  expect(Object.keys(flow).sort()).toEqual(['expiresAt', 'loginUrl', 'requestId'])
  expect((await native.pollBrowserLogin(flow.requestId)).status).toBe('pending')
  const complete = await fetch(base + '/api/v1/auth/device/complete', { method: 'POST', headers: { Origin: 'https://remote.example', Authorization: 'Bearer ' + user.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ browserToken: new URLSearchParams(new URL(flow.loginUrl).hash.slice(1)).get('device_login') }) })
  expect(complete.status).toBe(200)
  await expect(native.pollBrowserLogin(flow.requestId)).rejects.toThrow()
  expect((await native.pollBrowserLogin(flow.requestId)).status).toBe('complete')
  const saved = await credentials.load('https://remote.example', hostIdentity.deviceId)
  expect(saved?.account).toBe('a@example.com')
  expect((await api('/me', saved!.accessToken)).data.deviceId).toBe(hostIdentity.deviceId)
  const client = await device(user.token, 'client'), otherUser = await login('b@example.com'), otherClient = await device(otherUser.token, 'client')
  expect((await api('/devices', client.accessToken)).data.items.map((d:any) => d.deviceId)).toEqual([hostIdentity.deviceId])
  expect((await api('/devices', otherClient.accessToken)).data.items).toEqual([])
  native.close()
  const restored = new HostServerApi('https://remote.example', credentials, nativeFetch); restored.bindIdentity(hostIdentity)
  expect(await restored.hasStoredAuthorization()).toBe(true)
  await restored.clearAuthorization()
  expect(await restored.hasStoredAuthorization()).toBe(false)
  restored.close()
})
