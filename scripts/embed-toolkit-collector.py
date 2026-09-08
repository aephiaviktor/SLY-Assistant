from pathlib import Path
import json
root=Path(__file__).resolve().parents[1]
source=(root/'lib/toolkit-collector.js').read_text().split("if(typeof module!==")[0]
idl=(root/'lib/toolkit-upkeep-idl.json').read_text()
block='// BEGIN TOOLKIT COLLECTOR\n'+source+'\nconst toolkitUpkeepIdl = '+json.dumps(json.loads(idl),separators=(',',':'))+';\n// END TOOLKIT COLLECTOR\n'
for file in [root/'SLY_Assistant.user.js',root/'electron-app/app/SLY_Assistant.user.js']:
 s=file.read_text()
 if '// BEGIN TOOLKIT COLLECTOR' in s:
  a=s.index('// BEGIN TOOLKIT COLLECTOR');b=s.index('// END TOOLKIT COLLECTOR',a)+len('// END TOOLKIT COLLECTOR\n');s=s[:a]+block+s[b:]
 else:
  marker='\tlet cargoStatsDefinitionAcctPK = sageGameAcct.account.cargo.statsDefinition;'
  s=s.replace(marker,block+marker)
 file.write_text(s)
