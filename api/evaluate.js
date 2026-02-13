const crypto = require('crypto');
const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const XFYUN_CONFIG = {
  APPID: process.env.XFYUN_APPID,
  API_SECRET: process.env.XFYUN_API_SECRET,
  API_KEY: process.env.XFYUN_API_KEY,
  HOST: 'ise-api.xfyun.cn',
  URI: '/v2/open-ise'
};

function getAuthUrl() {
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${XFYUN_CONFIG.HOST}\ndate: ${date}\nGET ${XFYUN_CONFIG.URI} HTTP/1.1`;
  const hmac = crypto.createHmac('sha256', XFYUN_CONFIG.API_SECRET);
  const signature = hmac.update(signatureOrigin).digest('base64');
  const authorizationOrigin = `api_key="${XFYUN_CONFIG.API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin).toString('base64');
  return `wss://${XFYUN_CONFIG.HOST}${XFYUN_CONFIG.URI}?authorization=${authorization}&date=${encodeURIComponent(date)}&host=${XFYUN_CONFIG.HOST}`;
}

app.post('/api/evaluate', async (req, res) => {
  try {
    const { audio, text } = req.body;
    if (!audio || !text) return res.status(400).json({ success: false, error: 'Missing params' });
    console.log(`[Eval Request] Word: ${text}`);
    const result = await evaluateAudio(audio, text);
    return res.status(200).json(result);
  } catch (error) {
    console.error('[Error]', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => res.send('Server Active'));
app.listen(process.env.PORT || 8080);

function evaluateAudio(audioBase64, text) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getAuthUrl());
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    let finalResult = null;

    ws.on('open', () => {
      // 强制按照讯飞 Demo 的最简顺序构建 JSON 字符串
      const firstFrame = JSON.stringify({
        common: { app_id: XFYUN_CONFIG.APPID },
        business: {
          category: 'read_word',
          sub: 'ise',
          ent: 'en_vip',
          cmd: 'ssb',
          auf: 'audio/L16;rate=16000',
          aue: 'raw',
          tte: 'utf-8',
          text: Buffer.from('\uFEFF' + text).toString('base64'),
          ttp_skip: true,
          aus: 1
        },
        data: {
          status: 0,
          encoding: 'raw',
          data_type: 1,
          data: audioBuffer.slice(0, 5000).toString('base64')
        }
      });
      
      ws.send(firstFrame);

      // 发送后续数据
      let offset = 5000;
      const timer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return clearInterval(timer);
        const isLast = (offset + 5000 >= audioBuffer.length);
        const chunk = audioBuffer.slice(offset, Math.min(offset + 5000, audioBuffer.length));
        
        ws.send(JSON.stringify({
          data: {
            status: isLast ? 2 : 1,
            encoding: 'raw',
            data_type: 1,
            data: chunk.toString('base64')
          }
        }));
        
        offset += 5000;
        if (isLast) clearInterval(timer);
      }, 40);
    });

    ws.on('message', (data) => {
      const resp = JSON.parse(data);
      if (resp.code !== 0) {
        ws.close();
        return reject(new Error(`XFYUN ERROR ${resp.code}: ${resp.message}`));
      }
      if (resp.data && resp.data.status === 2) {
        finalResult = resp.data;
        ws.close();
        resolve(parseResult(finalResult));
      }
    });

    ws.on('error', () => reject(new Error('Connection Error')));
    ws.on('close', () => { if(!finalResult) reject(new Error('Closed without result')); });
  });
}

function parseResult(data) {
  try {
    const resObj = JSON.parse(Buffer.from(data.data, 'base64').toString('utf-8'));
    const word = resObj.read_word?.rec_paper?.read_chapter?.word?.[0] || {};
    return { success: true, score: Math.round(word.total_score || 0) };
  } catch (e) { return { success: false, error: 'Parse Error' }; }
}
