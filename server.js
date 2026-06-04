import express from 'express';
import cookieParser from 'cookie-parser';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import apiRouter from './routes/api.js';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.use('/api', apiRouter);

// Must be registered before express.static so index.html is never served raw
app.get('/', (_req, res) => {
  const rawKey = process.env.GOOGLE_MAPS_API_KEY || '';
  const key = rawKey.trim().replace(/^['"]|['"]$/g, '');
  if (!key || key === 'your_key_here') {
    console.error('Missing or placeholder GOOGLE_MAPS_API_KEY.');
    return res.status(500).send(
      '<h2>GOOGLE_MAPS_API_KEY is missing or invalid. Set it in your host environment variables and redeploy.</h2>'
    );
  }
  const html = readFileSync(join(__dirname, 'public/index.html'), 'utf8')
    .replace('%%GOOGLE_MAPS_API_KEY%%', key);
  res.send(html);
});

app.use(express.static(join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Flowmap`);
  console.log(`  http://localhost:${PORT}\n`);
});
