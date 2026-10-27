// Shared settings for the browser walkthroughs. Values come from the environment and server/.env.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ path: fileURLToPath(new URL('../server/.env', import.meta.url)), quiet: true });

/** The web app (Vite dev server or a built front end that proxies /api). */
export const BASE = process.env.LAIS_WEB_URL ?? 'http://localhost:5173';
/** Chromium-based browser to drive: Microsoft Edge is preinstalled on Windows. */
export const BROWSER = process.env.BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
/** The password the seed gave every synthetic account. */
export const PASSWORD = process.env.SEED_PASSWORD;
if (!PASSWORD) throw new Error('SEED_PASSWORD is not set (server/.env or environment)');
export const FIX = fileURLToPath(new URL('../server/fixtures', import.meta.url));
export const SHOTS = process.env.E2E_SHOTS_DIR ?? fileURLToPath(new URL('./shots', import.meta.url));
fs.mkdirSync(SHOTS, { recursive: true });
