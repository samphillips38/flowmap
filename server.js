import express from 'express';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// Must be registered before express.static so index.html is never served raw
app.get('/', (_req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY || '';
  if (!key || key === 'your_key_here') {
    return res.status(500).send(
      '<h2>Set GOOGLE_MAPS_API_KEY in your .env file (copied from .env.example) then restart.</h2>'
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
