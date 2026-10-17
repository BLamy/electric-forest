from pathlib import Path
import subprocess,sys
out=Path(__file__).resolve().parent
expected='6780c44343b29371bb7a82a012461772a665a49f977daa0fe14ba29fcdef3670'
actual=subprocess.check_output(['node','packages/cli/dist/src/bin.js','replay',str(Path(sys.argv[1]).resolve()),'--digest','--reducer','chat-channel'],cwd=out/'repo',text=True).strip()
print('expected='+expected+' actual='+actual,flush=True)
assert actual==expected,'one-byte mutation must be rejected against frozen committed expected digest'
print('FROZEN_DIGEST_SENSOR_OK')
