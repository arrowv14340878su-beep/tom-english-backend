const crypto = require('crypto');
const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 自动修剪空格，防止复制产生的不可见字符
const XFYUN_CONFIG = {
  APPID: (process.env.XFYUN_APPID || '').trim(),
  API_SECRET: (process.env.XFYUN_API_SECRET || '').trim(),
  API_KEY: (process.env.XFYUN_API_KEY || '').trim(),
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
    if (!audio || !text) return res.status(400).json({ success: false, error: 'Params missing' });
    console.log(`[Request] Word: ${text}, Audio Length: ${audio.length}`);
    const result = await evaluateAudio(audio, text);
    return res.status(200).json(result);
  } catch (error) {
    console.error('[Backend Error]', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => res.send('Server is ready!'));
app.listen(process.env.PORT || 8080);

function evaluateAudio(audioBase64, text) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getAuthUrl());
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    let finalResult = null;

    ws.on('open', () => {
      console.log('Connected to iFlytek ISE v2');
      
      const FRAME_SIZE = 5000;
      let offset = 0;

      const sendNext = () => {
        const isFirst = (offset === 0);
        const isLast = (offset + FRAME_SIZE >= audioBuffer.length);
        const chunk = audioBuffer.slice(offset, Math.min(offset + FRAME_SIZE, audioBuffer.length));
        
        // 【关键修复】强制要求 common 和 business 在 data 之前
        let frame = {};
        if (isFirst) {
          frame = {
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
              data: chunk.toString('base64')
            }
          };
        } else {
          frame = {
            data: {
              status: isLast ? 2 : 1,
              encoding: 'raw',
              data_type: 1,
              data: chunk.toString('base64')
            }
          };
        }

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(frame));
        }

        offset += FRAME_SIZE;
        if (!isLast) {
          setTimeout(sendNext, 40);
        }
      };

      sendNext();
    });

    ws.on('message', (data) => {
      const resp = JSON.parse(data);
      if (resp.code !== 0) {
        console.error(`iFlytek Error: [${resp.code}] ${resp.message}`);
        ws.close();
        return reject(new Error(`AI Error(${resp.code}): ${resp.message}`));
      }
      if (resp.data && resp.data.status === 2) {
        finalResult = resp.data;
        ws.close();
        resolve(parseResult(finalResult));
      }
    });

    ws.on('error', (err) => reject(new Error('WS Connection Error')));
    ws.on('close', () => { if (!finalResult) reject(new Error('Closed without score')); });
  });
}

function parseResult(data) {
  try {
    const resObj = JSON.parse(Buffer.from(data.data, 'base64').toString('utf-8'));
    const score = resObj.read_word?.rec_paper?.read_chapter?.word?.[0]?.total_score || 0;
    return { success: true, score: Math.round(score) };
  } catch (e) {
    return { success: false, error: 'Parse Error' };
  }
}
