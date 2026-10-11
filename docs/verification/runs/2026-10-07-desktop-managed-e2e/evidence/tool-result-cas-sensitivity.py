from pathlib import Path
import os
import subprocess,shutil,json,hashlib
REPO_ROOT = Path(__file__).resolve().parents[5]
source = Path(os.environ.get("REPO_ROOT", REPO_ROOT))
root = Path(os.environ.get("LUMI_E2E_TEST_RESULTS", REPO_ROOT / "test-results" / "tool-result-cas-sensitivity"))
root.mkdir(parents=True,exist_ok=False)
clone=root/"backend"
subprocess.run(["git","clone","--quiet","--shared",str(source),str(clone)],check=True)
for name in ["apps/api/src/repositories/tools.rs","apps/api/scripts/p05-tool-result-cas.py"]:
 target=clone/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source/name,target)
fixture=REPO_ROOT / "test-results/tool-execution-claim-p05-repaired-d1/v3/d1/miniflare-D1DatabaseObject/e7352547963de7050bd7d94658afc4fe78b61811b7815da12d90be8e863abf4d.sqlite"
def run(name):
 with (root/(name+".log")).open("w") as out:
  return subprocess.run(["python3","apps/api/scripts/p05-tool-result-cas.py",fixture],cwd=clone,stdout=out,stderr=subprocess.STDOUT).returncode
baseline=run("baseline");assert baseline==0,"no verdict without valid baseline"
target=clone/"apps/api/src/repositories/tools.rs";original=target.read_text()
begin=original.index("const ASSERT_TOOL_RESULT_STATUS_SQL:")
end=original.index('"#;',begin)
section=original[begin:end]
assert section.count("WHERE NOT EXISTS (")==1
target.write_text(original[:begin]+section.replace("WHERE NOT EXISTS (","WHERE 0 AND NOT EXISTS (",1)+original[end:])
try:mutation=run("mutation")
finally:target.write_text(original)
restored=run("restored")
report={"scope":"actual SQL result CAS and real audit on memory snapshots; not whole HTTP mutation","mutation":"valid SQL guard cannot abort stale result commit","baseline_exit":baseline,"mutation_exit":mutation,"restored_exit":restored,"source_unchanged":target.read_bytes()==(source/"apps/api/src/repositories/tools.rs").read_bytes(),"source_sha256":hashlib.sha256(target.read_bytes()).hexdigest()}
(root/"result.json").write_text(json.dumps(report,indent=2)+"\n")
assert mutation!=0 and restored==0 and report["source_unchanged"]
print(json.dumps(report))
