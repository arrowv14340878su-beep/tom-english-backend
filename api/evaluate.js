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
    if (!audio || !text) return res.status(400).json({ success: false, error: '缺少数据' });
    console.log(`[HTTP] 收到请求，单词: ${text}`);
    const result = await evaluateAudio(audio, text);
    return res.status(200).json(result);
  } catch (error) {
    console.error('[HTTP Error]', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => res.send('ISE Backend is Running!'));
app.listen(process.env.PORT || 8080);

function evaluateAudio(audioBase64, text) {
  return new Promise((resolve, reject) => {
    const authUrl = getAuthUrl();
    const ws = new WebSocket(authUrl);
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    let finalResult = null;

    ws.on('open', () => {
      console.log('[WS] 已连接，正在发送“纯指令”首帧...');

      // 第一帧：status: 0，不带音频数据。强制 cmd 排在 business 的最前面。
      const firstFrame = {
        common: { app_id: XFYUN_CONFIG.APPID },
        business: {
          cmd: 'ssb',
          sub: 'ise',
          ent: 'en_vip',
          category: 'read_word',
          auf: 'audio/L16;rate=16000',
          aue: 'raw',
          tte: 'utf-8',
          // 讯飞ISE V2 官方要求：Base64 编码的 UTF-8 文本且带 BOM 头
          text: Buffer.from('\ufeff' + text, 'utf8').toString('base64'),
          ttp_skip: true,
          aus: 1
        },
        data: {
          status: 0,
          data: "" // 首帧数据必须为空，纯握手参数
        }
      };

      ws.send(JSON.stringify(firstFrame));

      // 稍微延迟一下开始发音频数据，确保讯飞先处理完 ssb 指令
      setTimeout(() => {
        const FRAME_SIZE = 5000;
        let offset = 0;

        const timer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return clearInterval(timer);

          const isLast = (offset + FRAME_SIZE >= audioBuffer.length);
          const chunk = audioBuffer.slice(offset, Math.min(offset + FRAME_SIZE, audioBuffer.length));

          const audioFrame = {
            data: {
              status: isLast ? 2 : 1,
              encoding: 'raw',
              data_type: 1,
              data: chunk.toString('base64')
            }
          };

          ws.send(JSON.stringify(audioFrame));
          offset += FRAME_SIZE;

          if (isLast) {
            console.log('[WS] 音频发送完毕');
            clearInterval(timer);
          }
        }, 40);
      }, 100); 
    });

    ws.on('message', (data) => {
      const resp = JSON.parse(data);
      if (resp.code !== 0) {
        console.error('[WS Error Response]', JSON.stringify(resp));
        ws.close();
        return reject(new Error(`讯飞报错(${resp.code}): ${resp.message}`));
      }
      
      if (resp.data && resp.data.status === 2) {
        finalResult = resp.data;
        ws.close();
        resolve(parseResult(finalResult));
      }
    });

    ws.on('error', (err) => reject(new Error('WS连接错误')));
    ws.on('close', () => { if (!finalResult) reject(new Error('连接关闭，未收到评分')); });
    setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.close(); }, 30000);
  });
}

function parseResult(data) {
  try {
    const resStr = Buffer.from(data.data, 'base64').toString('utf-8');
    const resObj = JSON.parse(resStr);
    const wordInfo = resObj.read_word?.rec_paper?.read_chapter?.word?.[0] || {};
    return {
      success: true,
      score: Math.round(wordInfo.total_score || 0),
      accuracy: Math.round(wordInfo.accuracy_score || 0)
    };
  } catch (e) {
    return { success: false, error: '解析结果失败' };
  }
}
