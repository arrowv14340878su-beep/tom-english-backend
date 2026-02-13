const crypto = require('crypto');
const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const XFYUN_CONFIG = {
  APPID: (process.env.XFYUN_APPID || '').trim(),
  API_SECRET: (process.env.XFYUN_API_SECRET || '').trim(),
  API_KEY: (process.env.XFYUN_API_KEY || '').trim(),
  HOST: 'ise-api.xfyun.cn',
  URI: '/v2/open-ise'
};

function getAuthUrl() {
  const date = new Date().toUTCString();
  // 签名原串：注意 GET 后面有个空格，URI 后面有个空格
  const signatureOrigin = `host: ${XFYUN_CONFIG.HOST}\ndate: ${date}\nGET ${XFYUN_CONFIG.URI} HTTP/1.1`;
  const hmac = crypto.createHmac('sha256', XFYUN_CONFIG.API_SECRET);
  const signature = hmac.update(signatureOrigin).digest('base64');
  const authOrigin = `api_key="${XFYUN_CONFIG.API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authOrigin).toString('base64');
  return `wss://${XFYUN_CONFIG.HOST}${XFYUN_CONFIG.URI}?authorization=${authorization}&date=${encodeURIComponent(date)}&host=${XFYUN_CONFIG.HOST}`;
}

app.post('/api/evaluate', async (req, res) => {
  try {
    const { audio, text } = req.body;
    console.log(`[TomEnglish] 单词: ${text}, 长度: ${audio.length}`);
    const result = await evaluateAudio(audio, text);
    res.json(result);
  } catch (error) {
    console.error('[Final Error]', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => res.send('Backend is Ready'));
app.listen(process.env.PORT || 8080);

function evaluateAudio(audioBase64, text) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const ws = new WebSocket(getAuthUrl());
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    const FRAME_SIZE = 1280;
    let offset = 0;

    ws.on('open', () => {
      const sendNext = () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const chunk = audioBuffer.slice(offset, Math.min(offset + FRAME_SIZE, audioBuffer.length));
        const isFirst = (offset === 0);
        const isLast = (offset + chunk.length >= audioBuffer.length);
        
        const frame = {
          data: {
            status: isFirst ? 0 : (isLast ? 2 : 1),
            encoding: 'raw', data_type: 1,
            data: chunk.toString('base64')
          }
        };

        if (isFirst) {
          frame.common = { app_id: XFYUN_CONFIG.APPID };
          frame.business = {
            category: 'read_word', sub: 'ise', ent: 'en_vip', cmd: 'ssb',
            auf: 'audio/L16;rate=16000', aue: 'raw', tte: 'utf-8',
            text: Buffer.from('\ufeff' + text).toString('base64'),
            ttp_skip: true
          };
        }

        ws.send(JSON.stringify(frame));
        offset += chunk.length;
        if (!isLast) setTimeout(sendNext, 40);
      };
      sendNext();
    });

    ws.on('message', (data) => {
      const resp = JSON.parse(data);
      if (resp.code !== 0) {
        finished = true;
        ws.terminate();
        reject(new Error(`讯飞报错(${resp.code}): ${resp.message}`));
      } else if (resp.data && resp.data.status === 2) {
        finished = true;
        const resObj = JSON.parse(Buffer.from(resp.data.data, 'base64').toString('utf-8'));
        const score = resObj.read_word?.rec_paper?.read_chapter?.word?.[0]?.total_score || 0;
        ws.close();
        resolve({ success: true, score: Math.round(score) });
      }
    });

    ws.on('error', (err) => { if(!finished) { finished=true; reject(err); } });
    ws.on('close', () => { if(!finished) { finished=true; reject(new Error('WS已关闭')); } });
    setTimeout(() => { if(!finished) { finished=true; ws.terminate(); reject(new Error('超时')); } }, 20000);
  });
}
