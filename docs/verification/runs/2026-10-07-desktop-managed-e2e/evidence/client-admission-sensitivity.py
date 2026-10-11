from pathlib import Path
import subprocess, shutil, json, hashlib, os
source=Path("/Volumes/SSD/symlinks/james-home/codex/worktrees/desktop-e2e/agents-cp.runlumi/integrations/lumi-agents")
root=Path("/Volumes/SSD/agents-cp.runlumi/test-results/client-admission-sensitivity")
root.mkdir(parents=True,exist_ok=False)
clone=root/"client"
subprocess.run(["git","clone","--quiet","--shared",str(source),str(clone)],check=True)
files=["deviceTransport.ts","errors.ts","managedRunTransport.ts","managedToolTransport.ts","managedToolTransport.test.ts","managedToolAdmission.test.ts"]
for name in files:
 target=clone/"packages/services/src/lumi-account"/name
 target.parent.mkdir(parents=True,exist_ok=True)
 shutil.copy2(source/"packages/services/src/lumi-account"/name,target)
(clone/"node_modules").symlink_to(source/"node_modules",target_is_directory=True)
(clone/"packages/services/node_modules").symlink_to(source/"packages/services/node_modules",target_is_directory=True)
env=dict(os.environ)
env["PATH"]="/Users/james/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:"+env["PATH"]
env["TMPDIR"]="/Volumes/SSD/agents-cp.runlumi/test-results/t"
def run(name):
 with (root/(name+".log")).open("w") as out:
  return subprocess.run(["node","--import","tsx","--test","packages/services/src/lumi-account/managedToolTransport.test.ts","packages/services/src/lumi-account/managedToolAdmission.test.ts"],cwd=clone,env=env,stdout=out,stderr=subprocess.STDOUT).returncode
baseline=run("baseline")
assert baseline==0,"no mutation verdict without valid positive baseline"
target=clone/"packages/services/src/lumi-account/managedToolTransport.ts"
original=target.read_text()
needle='if (result.decision !== "allow") return result;'
assert original.count(needle)==1
target.write_text(original.replace(needle,needle+"\n    return result; // deliberate claim omission",1))
try: mutation=run("mutation")
finally: target.write_text(original)
restored=run("restored")
report={"scope":"production client admission barrier with loopback HTTP/file handler regressions; not full Electron tool gate","baseline_exit":baseline,"mutation_exit":mutation,"restored_exit":restored,"mutation":"release policy allow without requesting execution claim","source_unchanged":target.read_bytes()==(source/"packages/services/src/lumi-account/managedToolTransport.ts").read_bytes(),"source_sha256":hashlib.sha256(target.read_bytes()).hexdigest()}
(root/"result.json").write_text(json.dumps(report,indent=2)+"\n")
assert mutation!=0 and restored==0 and report["source_unchanged"]
print(json.dumps(report))
