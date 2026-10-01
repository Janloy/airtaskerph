import os from 'node:os';
import { createRequire } from 'node:module';

os.userInfo = () => ({ shell: process.env.SHELL || process.env.COMSPEC || 'cmd.exe' });
process.argv = [process.execPath, 'capacitor', ...process.argv.slice(2)];
createRequire(import.meta.url)('../node_modules/@capacitor/cli/bin/capacitor');
