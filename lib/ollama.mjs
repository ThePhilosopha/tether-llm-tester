import { spawn } from 'node:child_process';

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SETTINGS = new Set(['OLLAMA_NUM_PARALLEL', 'OLLAMA_MAX_LOADED_MODELS', 'OLLAMA_KEEP_ALIVE', 'OLLAMA_ORIGINS', 'OLLAMA_FLASH_ATTENTION', 'OLLAMA_KV_CACHE_TYPE']);

export function validateModelName(name) {
  if (typeof name !== 'string' || !MODEL_NAME.test(name)) throw new Error('Model names may contain only letters, numbers, dots, underscores, colons, slashes, and hyphens.');
  return name;
}

export function validateSettings(settings) {
  if (!settings || typeof settings !== 'object') throw new Error('Settings must be an object.');
  for (const [key, value] of Object.entries(settings)) {
    if (!SETTINGS.has(key) || typeof value !== 'string' || value.length > 200 || /[\r\n\0]/.test(value)) throw new Error(`Invalid Ollama setting: ${key}`);
  }
  return settings;
}

export function runOllama(args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ollama', args, { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => reject(new Error(`Could not start ollama: ${error.message}`)));
    child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr.trim() || `ollama exited with ${code}`)));
  });
}

export function macosEnvCommands(settings) {
  validateSettings(settings);
  return Object.entries(settings).map(([key, value]) => ['setenv', key, value]);
}
