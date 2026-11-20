import sys,os,time,subprocess,psutil,uuid,json
if len(sys.argv) < 2:
 sys.exit('Usage: python3 scripts/check-with-budget.py COMMAND [ARG ...]')
avail=psutil.virtual_memory().available
idle=psutil.cpu_times_percent(interval=1).idle/100*psutil.cpu_count()
mem=min(2*1024**3,avail//3)
quota=min(100,int(idle/3*100))
if avail<6*1024**3 or quota<25:sys.exit('Insufficient idle resources; no test started')
unit='xagent-check-'+uuid.uuid4().hex[:10]
args=['systemd-run','--quiet','--wait','--pipe','--collect','--unit='+unit,'-p','WorkingDirectory='+os.getcwd(),'-p',f'MemoryMax={mem}','-p',f'MemoryHigh={mem*3//4}','-p','MemorySwapMax=0','-p','OOMPolicy=kill','-p',f'CPUQuota={quota}%','-p','CPUWeight=1','-p','IOWeight=1','-p','Nice=15','-p','IOSchedulingClass=idle','-p','TasksMax=256','-p','RuntimeMaxSec=600','-p','TimeoutStopSec=5','-p','KillMode=control-group','--setenv=NODE_OPTIONS=--max-old-space-size=1024',*sys.argv[1:]]
print(json.dumps({'unit':unit,'memory_limit_mib':mem//1024**2,'cpu_quota_percent':quota,'idle_cpu_cores':round(idle,2)}),flush=True)
if sys.argv[1:] == ['--dry-run']: sys.exit(0)
p=subprocess.Popen(args)
try:
 while p.poll() is None:
  time.sleep(1)
  now=psutil.virtual_memory().available
  if now<6*1024**3 or mem>now//3:
   print('Stopping only this check: free-resource budget decreased',flush=True)
   subprocess.run(['systemctl','stop',unit],check=False,stdout=subprocess.DEVNULL);break
 code=p.wait()
finally:
 subprocess.run(['systemctl','stop',unit],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
print('Check cgroup stopped; child processes released.',flush=True)
sys.exit(code)
