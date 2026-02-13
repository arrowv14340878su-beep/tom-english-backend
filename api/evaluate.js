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
    if (!audio || !text) return res.status(400).json({ success: false, error: '缺少音频或文本' });
    
    console.log(`[收到请求] 单词: ${text}, 原始Base64长度: ${audio.length}`);
    const result = await evaluateAudio(audio, text);
    return res.status(200).json(result);
  } catch (error) {
    console.error('[评测失败]', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => res.send('Tom English Backend is Running!'));

const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => console.log(`服务端口: ${port}`));

// 核心逻辑：分片发送音频
function evaluateAudio(audioBase64, text) {
  return new Promise((resolve, reject) => {
    const wsUrl = getAuthUrl();
    const ws = new WebSocket(wsUrl);
    
    // 将Base64转为Buffer，方便切割
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    const FRAME_SIZE = 5000; // 每片5KB，远低于讯飞26KB限制
    let finalResult = null;

    ws.on('open', () => {
      let offset = 0;
      let status = 0; // 0:第一帧, 1:中间帧, 2:最后一帧

      const sendNextFrame = () => {
        const isFirstFrame = (offset === 0);
        const isLastFrame = (offset + FRAME_SIZE >= audioBuffer.length);
        const currentStatus = isFirstFrame ? 0 : (isLastFrame ? 2 : 1);
        
        const end = Math.min(offset + FRAME_SIZE, audioBuffer.length);
        const chunk = audioBuffer.slice(offset, end);

        const frame = {
          data: {
            status: currentStatus,
            encoding: 'raw',
            data_type: 1,
            data: chunk.toString('base64')
          }
        };

        // 只有第一帧需要带上 business 和 common 参数
        if (isFirstFrame) {
          frame.common = { app_id: XFYUN_CONFIG.APPID };
          frame.business = {
            category: 'read_word',
            sub: 'ise',
            ent: 'en_vip',
            cmd: 'ssb',
            auf: 'audio/L16;rate=16000',
            aue: 'raw',
            text: Buffer.from('\uFEFF' + text).toString('base64'),
            ttp_skip: true,
            aus: 1
          };
        }

        ws.send(JSON.stringify(frame));
        
        offset += FRAME_SIZE;
        if (!isLastFrame) {
          // 讯飞建议发送间隔为40ms左右，模拟真实语音流
          setTimeout(sendNextFrame, 40);
        }
      };

      sendNextFrame();
    });

    ws.on('message', (data) => {
      const response = JSON.parse(data);
      if (response.code !== 0) {
        ws.close();
        return reject(new Error(`讯飞错误(${response.code}): ${response.message}`));
      }
      if (response.data && response.data.status === 2) {
        finalResult = response.data;
        ws.close();
        resolve(parseResult(finalResult));
      }
    });

    ws.on('error', (err) => reject(new Error('WS连接错误: ' + err.message)));
    ws.on('close', () => { if (!finalResult) reject(new Error('连接关闭，无结果')); });
  });
}

function parseResult(data) {
  try {
    const resultStr = Buffer.from(data.data, 'base64').toString('utf-8');
    const resultObj = JSON.parse(resultStr);
    const scoreInfo = resultObj.read_word?.rec_paper?.read_chapter?.word?.[0] || {};
    return {
      success: true,
      score: Math.round(scoreInfo.total_score || 0),
      accuracy: Math.round(scoreInfo.accuracy_score || 0),
      fluency: Math.round(scoreInfo.fluency_score || 0)
    };
  } catch (e) {
    return { success: false, error: '结果解析失败' };
  }
}
