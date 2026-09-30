"""Run all current suites and build a traceable aggregate report."""
from pathlib import Path
import hashlib,json,subprocess,sys,datetime
ROOT=Path(__file__).resolve().parents[1]
for script in ['test_flux.py','test_experience.py','test_refinement.py','test_contrast.py']:
    subprocess.run([sys.executable,str(ROOT/'tests'/script)],check=True)
parts=[json.loads((ROOT/'tests'/name).read_text()) for name in ['regression-report.json','experience-report.json','refinement-report.json']]
contrast=json.loads((ROOT/'tests/contrast-v11.json').read_text())
report={'app':'Flux Studio 11','schema':11,'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'html': 'flux-studio-v11.html','sha256':hashlib.sha256((ROOT/'flux-studio-v11.html').read_bytes()).hexdigest(),'passed':sum(p['passed'] for p in parts),'failed':sum(p['failed'] for p in parts),'browserErrors':[e for p in parts for e in p['browserErrors']],'suiteCounts':{'core':parts[0]['passed'],'returnAgentLive':parts[1]['passed'],'v11Refinement':parts[2]['passed']},'contrast':{'passed':contrast['passed'],'failed':contrast['failed'],'report':'contrast-v11.json'},'tests':[t for p in parts for t in p['tests']],'limits':{'storage':'Explicit memory double; native file persistence NOT verified','media':'API/stream doubles; no remote transmission','ai':'Extractive/private and rule-based DEMO, no model API','authorization':'Local scope model, not server access control','accessibility':'Selected contrast/layout/keyboard checks, not full WCAG audit','usability':'No study with end users'}}
(ROOT/'tests/report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print('ALL',report['passed'],'interaction checks;',contrast['passed'],'contrast pairs')
