
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
    if (!audio || !text) return res.status(400).json({ success: false, error: '参数缺失' });
    console.log(`[收到请求] 单词: ${text}, 长度: ${audio.length}`);
    const result = await evaluateAudio(audio, text);
    return res.status(200).json(result);
  } catch (error) {
    console.error('[错误日志]', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => res.send('Tom English Backend is Ready'));
const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0");

function evaluateAudio(audioBase64, text) {
  return new Promise((resolve, reject) => {
    const wsUrl = getAuthUrl();
    const ws = new WebSocket(wsUrl);
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    let finalResult = null;

    ws.on('open', () => {
      console.log('已连接讯飞，开始分片发送...');
      
      const FRAME_SIZE = 5000; // 每帧5KB
      let offset = 0;

      const sendNext = () => {
        const isFirst = (offset === 0);
        const isLast = (offset + FRAME_SIZE >= audioBuffer.length);
        const end = Math.min(offset + FRAME_SIZE, audioBuffer.length);
        const chunk = audioBuffer.slice(offset, end);

        const frame = {
          data: {
            status: isFirst ? 0 : (isLast ? 2 : 1),
            encoding: 'raw',
            data_type: 1,
            data: chunk.toString('base64')
          }
        };

        if (isFirst) {
          frame.common = { app_id: XFYUN_CONFIG.APPID };
          frame.business = {
            category: 'read_word',
            sub: 'ise',
            ent: 'en_vip',
            cmd: 'ssb',
            auf: 'audio/L16;rate=16000',
            aue: 'raw',
            tte: 'utf-8',
            text: Buffer.from('\uFEFF' + text).toString('base64'),
            ttp_skip: true, // 【关键修复】必须是 true (布尔值)
            aus: 1
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
        console.error('讯飞报错:', resp.message);
        ws.close();
        return reject(new Error(`AI错误(${resp.code}): ${resp.message}`));
      }
      
      if (resp.data && resp.data.status === 2) {
        finalResult = resp.data;
        ws.close();
        resolve(parseResult(finalResult));
      }
    });

    ws.on('error', (err) => reject(new Error('网络连接异常')));
    ws.on('close', () => { if (!finalResult) reject(new Error('未收到结果连接断开')); });
    setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.close(); }, 20000);
  });
}

function parseResult(data) {
  try {
    const resStr = Buffer.from(data.data, 'base64').toString('utf-8');
    const resObj = JSON.parse(resStr);
    // 兼容讯飞ISE v2 JSON返回结构
    const word = resObj.read_word?.rec_paper?.read_chapter?.word?.[0] || {};
    return {
      success: true,
      score: Math.round(word.total_score || 0),
      accuracy: Math.round(word.accuracy_score || 0)
    };
  } catch (e) {
    return { success: false, error: '结果解析异常' };
  }
}
