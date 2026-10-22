// Every workflow file parses as YAML. An invalid one is not "skipped": GitHub
// records a FAILED run of it on every push to the branch and emails the owner
// each time (2026-10-22: six emails overnight from a commit message whose second
// line sat at column 1 inside a `run: |` block). PyYAML does the parsing, as it
// is on every GitHub runner and this machine; where it is missing the check
// says so and passes, rather than failing for the wrong reason.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const dir = '.github/workflows';
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => `${dir}/${f}`);
const py = `
import sys, yaml
bad = 0
for f in sys.argv[1:]:
    try:
        d = yaml.safe_load(open(f))
        assert isinstance(d, dict) and ('on' in d or True in d) and 'jobs' in d, 'no on:/jobs:'
    except Exception as e:
        bad += 1
        print(f"FAIL  {f}: {str(e).splitlines()[0][:160]}")
print(f"{len(sys.argv) - 1 - bad} of {len(sys.argv) - 1} workflow files parse")
sys.exit(1 if bad else 0)
`;
const r = spawnSync('python3', ['-c', py, ...files], { encoding: 'utf8' });
if (r.error || /No module named 'yaml'/.test(r.stderr || '')) {
  console.log('workflows-yaml: python3 with PyYAML not here; not checked');
} else {
  process.stdout.write(r.stdout);
  if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(1); }
  console.log('workflows-yaml: ok');
}
