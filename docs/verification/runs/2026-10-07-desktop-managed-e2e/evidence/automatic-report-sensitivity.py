from pathlib import Path
import subprocess,shutil,json,hashlib,os
source=Path("/Volumes/SSD/symlinks/james-home/codex/worktrees/desktop-e2e/agents-cp.runlumi/integrations/lumi-agents")
root=Path("/Volumes/SSD/agents-cp.runlumi/test-results/automatic-result-core-sensitivity-bounded")
root.mkdir(parents=True,exist_ok=False)
clone=root/"client"
subprocess.run(["git","clone","--quiet","--shared",str(source),str(clone)],check=True)
shutil.copytree(source/"apps/zcode-cli/packages/core/src",clone/"apps/zcode-cli/packages/core/src",dirs_exist_ok=True)
(clone/"node_modules").symlink_to(source/"node_modules",target_is_directory=True)
(clone/"apps/zcode-cli/packages/core/node_modules").symlink_to(source/"apps/zcode-cli/packages/core/node_modules",target_is_directory=True)
env=dict(os.environ);env["PATH"]="/Users/james/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:"+env["PATH"];env["TMPDIR"]="/Volumes/SSD/agents-cp.runlumi/test-results/t"
def run(name):
 with (root/(name+".log")).open("w") as out:
  return subprocess.run(["node","--import","tsx","--test","apps/zcode-cli/packages/core/src/tool/executor/managed-decision.test.ts"],cwd=clone,env=env,stdout=out,stderr=subprocess.STDOUT).returncode
baseline=run("baseline");assert baseline==0,"no verdict without valid baseline"
target=clone/"apps/zcode-cli/packages/core/src/tool/executor/managed-handler.ts";original=target.read_text()
needle="await gate.reportResult?.(status);";assert original.count(needle)==1
target.write_text(original.replace(needle,"void status; // deliberate report omission",1))
try:mutation=run("mutation")
finally:target.write_text(original)
restored=run("restored")
report={"scope":"actual Core handler reporter/ACK tests; not full Electron mutation","mutation":"omit automatic result report after handler","baseline_exit":baseline,"mutation_exit":mutation,"restored_exit":restored,"source_unchanged":target.read_bytes()==(source/"apps/zcode-cli/packages/core/src/tool/executor/managed-handler.ts").read_bytes(),"source_sha256":hashlib.sha256(target.read_bytes()).hexdigest()}
(root/"result.json").write_text(json.dumps(report,indent=2)+"\n")
assert mutation!=0 and restored==0 and report["source_unchanged"]
print(json.dumps(report))
