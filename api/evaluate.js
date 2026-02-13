const crypto = require('crypto');
const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');

const app = express();

// 1. 允许跨域和处理大数据包 (base64语音通常很大)
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 讯飞API配置
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

// 2. 将原本的函数包装成路由
app.post('/api/evaluate', async (req, res) => {
  try {
    const { audio, text } = req.body;
    if (!audio || !text) return res.status(400).json({ error: 'Missing audio or text' });

    if (!XFYUN_CONFIG.APPID || !XFYUN_CONFIG.API_SECRET || !XFYUN_CONFIG.API_KEY) {
      return res.status(500).json({ error: 'Server configuration error: Missing XFYUN keys in Environment Variables' });
    }

    const result = await evaluateAudio(audio, text);
    return res.status(200).json(result);
  } catch (error) {
    console.error('Evaluation error:', error);
    return res.status(500).json({ error: 'Evaluation failed', message: error.message });
  }
});

// 健康检查接口（方便Railway检查你的程序是否活着）
app.get('/', (req, res) => res.send('Server is running!'));

// 3. 核心修改：让程序监听 Railway 分配的端口
const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Server is running on port ${port}`);
});

// --- 以下是原有的 evaluateAudio 和 parseEvaluationResult 函数，保持不变 ---

function evaluateAudio(audioBase64, text) {
  return new Promise((resolve, reject) => {
    const wsUrl = getAuthUrl();
    const ws = new WebSocket(wsUrl);
    let result = null;
    ws.on('open', () => {
      const params = {
        common: { app_id: XFYUN_CONFIG.APPID },
        business: {
          category: 'read_word', sub: 'ise', ent: 'en_vip', cmd: 'ssb',
          auf: 'audio/L16;rate=16000', aue: 'raw',
          text: Buffer.from(text).toString('base64'), ttp_skip: true, aus: 1
        },
        data: { status: 2, encoding: 'raw', audio: audioBase64, data_type: 1 }
      };
      ws.send(JSON.stringify(params));
    });
    ws.on('message', (data) => {
      const response = JSON.parse(data);
      if (response.code !== 0) { ws.close(); reject(new Error(`API Error: ${response.message}`)); return; }
      if (response.data) result = response.data;
      if (response.data && response.data.status === 2) {
        ws.close();
        const evalResult = parseEvaluationResult(result);
        resolve(evalResult);
      }
    });
    ws.on('error', reject);
    ws.on('close', () => { if (!result) reject(new Error('Connection closed without result')); });
    setTimeout(() => { if (ws.readyState === WebSocket.OPEN) { ws.close(); reject(new Error('Evaluation timeout')); } }, 15000);
  });
}

function parseEvaluationResult(data) {
  try {
    const resultStr = Buffer.from(data.data, 'base64').toString('utf-8');
    const resultObj = JSON.parse(resultStr);
    const word = resultObj.read_word?.rec_paper?.read_chapter?.word?.[0] || {};
    return {
      success: true,
      score: Math.round(word.total_score || 0),
      accuracy: Math.round(word.accuracy_score || 0),
      fluency: Math.round(word.fluency_score || 0),
      details: resultObj
    };
  } catch (error) {
    return { success: false, error: 'Failed to parse result' };
  }
}
