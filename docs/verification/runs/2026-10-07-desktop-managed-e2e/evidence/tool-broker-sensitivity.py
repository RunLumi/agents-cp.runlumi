from pathlib import Path
import subprocess, shutil, json, hashlib
source=Path("/Volumes/SSD/symlinks/james-home/codex/worktrees/desktop-e2e/agents-cp.runlumi/integrations/lumi-agents")
root=Path("/Volumes/SSD/agents-cp.runlumi/test-results/tool-broker-sensitivity")
root.mkdir(parents=True,exist_ok=True)
clone=root/"client"
if not clone.exists(): subprocess.run(["git","clone","--quiet","--shared",str(source),str(clone)],check=True)
files=["packages/services/src/lumi-account/deviceTransport.ts","packages/services/src/lumi-account/errors.ts","packages/services/src/lumi-account/managedRunTransport.ts","packages/services/src/lumi-account/managedToolTransport.ts","packages/services/src/lumi-account/managedToolTransport.test.ts"]
for name in files:
    target=clone/name
    target.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(source/name,target)
if not (clone/"node_modules").exists(): (clone/"node_modules").symlink_to(source/"node_modules",target_is_directory=True)
if not (clone/"packages/services/node_modules").exists(): (clone/"packages/services/node_modules").symlink_to(source/"packages/services/node_modules",target_is_directory=True)
if (root/"baseline.log").exists() and not (root/"initial-dependencies-fail.log").exists(): (root/"baseline.log").rename(root/"initial-dependencies-fail.log")
env=dict(__import__("os").environ)
env["PATH"]="/Users/james/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:"+env["PATH"]
def run(name):
    with (root/(name+".log")).open("w") as out:
        return subprocess.run(["node","--import","tsx","--test","packages/services/src/lumi-account/managedToolTransport.test.ts"],cwd=clone,env=env,stdout=out,stderr=subprocess.STDOUT).returncode
baseline=run("baseline")
if baseline != 0: raise RuntimeError("baseline did not run successfully")
target=clone/"packages/services/src/lumi-account/managedToolTransport.ts"
original=target.read_text()
needle="result.runId !== params.context.runId ||"
assert original.count(needle)==1
target.write_text(original.replace(needle,"",1))
try:
    mutation=run("mutation")
finally:
    target.write_text(original)
restored=run("restored")
report={"scope":"DeviceToken loopback transport binding, not full Electron tool effects","baseline_exit":baseline,"mutation_exit":mutation,"restored_exit":restored,"mutation":"omit only run ID binding predicate; valid positive HTTP control still executes","source_unchanged":target.read_bytes()==(source/"packages/services/src/lumi-account/managedToolTransport.ts").read_bytes(),"source_sha256":hashlib.sha256(target.read_bytes()).hexdigest()}
(root/"result.json").write_text(json.dumps(report,indent=2)+"\n")
assert mutation != 0 and restored == 0 and report["source_unchanged"]
print(json.dumps(report))
