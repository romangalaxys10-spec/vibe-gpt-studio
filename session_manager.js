import fs from 'fs';
import path from 'path';
import os from 'os';

const SESSIONS_DIR = path.join(os.homedir(), '.vibe-gpt-studio', 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

export function getAllSessions() {
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  const sessions = [];

  for (const file of files) {
    try {
      const data = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8');
      sessions.push(JSON.parse(data));
    } catch (e) {
      console.error(`Error reading session file ${file}:`, e);
    }
  }

  return sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function getSessionById(id) {
  const filePath = path.join(SESSIONS_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function saveSession(session) {
  const filePath = path.join(SESSIONS_DIR, `${session.id}.json`);
  const data = {
    ...session,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return data;
}

export function deleteSession(id) {
  const filePath = path.join(SESSIONS_DIR, `${id}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}
