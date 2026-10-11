from pathlib import Path
import os
import subprocess, shutil, json, hashlib
REPO_ROOT = Path(__file__).resolve().parents[5]
source = Path(os.environ.get("LUMI_AGENTS_DIR", REPO_ROOT / "integrations/lumi-agents"))
root = Path(os.environ.get("LUMI_E2E_TEST_RESULTS", REPO_ROOT / "test-results" / "tool-broker-sensitivity"))
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
env["PATH"]=os.environ.get("NODE24_BIN", "node").rsplit("/", 1)[0] + ":" + env["PATH"] if "/" in os.environ.get("NODE24_BIN", "node") else env["PATH"]
def run(name):
    with (root/(name+".log")).open("w") as out:
        return subprocess.run([os.environ.get("NODE24_BIN", "node"),"--import","tsx","--test","packages/services/src/lumi-account/managedToolTransport.test.ts"],cwd=clone,env=env,stdout=out,stderr=subprocess.STDOUT).returncode
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
