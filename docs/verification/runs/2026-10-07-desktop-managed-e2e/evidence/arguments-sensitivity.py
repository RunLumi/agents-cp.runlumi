from pathlib import Path
import os
import subprocess, shutil, json, hashlib, os
REPO_ROOT = Path(__file__).resolve().parents[5]
source = Path(os.environ.get("LUMI_AGENTS_DIR", REPO_ROOT / "integrations/lumi-agents"))
root = Path(os.environ.get("LUMI_E2E_TEST_RESULTS", REPO_ROOT / "test-results" / "argument-binding-sensitivity"))
root.mkdir(parents=True,exist_ok=False)
clone=root/"client"
subprocess.run(["git","clone","--quiet","--shared",str(source),str(clone)],check=True)
shutil.copytree(source/"apps/zcode-cli/packages/core/src",clone/"apps/zcode-cli/packages/core/src",dirs_exist_ok=True)
(clone/"node_modules").symlink_to(source/"node_modules",target_is_directory=True)
(clone/"apps/zcode-cli/packages/core/node_modules").symlink_to(source/"apps/zcode-cli/packages/core/node_modules",target_is_directory=True)
env=dict(os.environ)
env["PATH"]=os.environ.get("NODE24_BIN", "node").rsplit("/", 1)[0] + ":" + env["PATH"] if "/" in os.environ.get("NODE24_BIN", "node") else env["PATH"]
args=[os.environ.get("NODE24_BIN", "node"),"--import","tsx","--test","apps/zcode-cli/packages/core/src/tool/executor/managed-arguments.test.ts","apps/zcode-cli/packages/core/src/tool/executor/managed-decision.test.ts"]
def run(name):
    with (root/(name+".log")).open("w") as out:
        return subprocess.run(args,cwd=clone,env=env,stdout=out,stderr=subprocess.STDOUT).returncode
baseline=run("baseline")
assert baseline == 0, "baseline failed; no mutation verdict"
target=clone/"apps/zcode-cli/packages/core/src/tool/executor/managed-handler.ts"
original=target.read_text()
needle="return handler(snapshot, context);"
assert original.count(needle)==1
target.write_text(original.replace(needle,"return handler(input, context);",1))
try:
    mutation=run("mutation")
finally:
    target.write_text(original)
restored=run("restored")
result={"scope":"actual Core executor argument ownership; not full Electron tool approval","mutation":"deliver caller-owned input instead of isolated approved snapshot","baseline_exit":baseline,"mutation_exit":mutation,"restored_exit":restored,"source_unchanged":target.read_bytes()==(source/"apps/zcode-cli/packages/core/src/tool/executor/managed-handler.ts").read_bytes(),"source_sha256":hashlib.sha256(target.read_bytes()).hexdigest()}
(root/"result.json").write_text(json.dumps(result,indent=2)+"\n")
assert mutation != 0 and restored == 0 and result["source_unchanged"]
print(json.dumps(result))
