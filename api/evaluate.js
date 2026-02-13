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
    
    console.log(`[新请求] 单词: ${text}, 音频Base64长度: ${audio.length}`);
    const result = await evaluateAudio(audio, text);
    return res.status(200).json(result);
  } catch (error) {
    console.error('[评测异常]', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => res.send('Backend is running!'));

const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => console.log(`服务已启动，端口: ${port}`));

function evaluateAudio(audioBase64, text) {
  return new Promise((resolve, reject) => {
    const wsUrl = getAuthUrl();
    const ws = new WebSocket(wsUrl);
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    let finalResult = null;

    ws.on('open', () => {
      console.log('连接讯飞成功，正在发送首帧参数...');
      
      // 1. 第一帧：只发参数 (status: 0)，cmd: ssb 必须在这里
      const firstFrame = {
        common: { app_id: XFYUN_CONFIG.APPID },
        business: {
          category: 'read_word',
          sub: 'ise',
          ent: 'en_vip',
          cmd: 'ssb',
          auf: 'audio/L16;rate=16000',
          aue: 'raw',
          text: Buffer.from('\uFEFF' + text).toString('base64'),
          ttp_skip: true,
          aus: 1
        },
        data: {
          status: 0,
          encoding: 'raw',
          data_type: 1,
          data: '' // 第一帧可以不带音频
        }
      };
      ws.send(JSON.stringify(firstFrame));

      // 2. 分片发送中间帧 (status: 1) 和 最后一帧 (status: 2)
      const FRAME_SIZE = 5000;
      let offset = 0;

      const interval = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          clearInterval(interval);
          return;
        }

        const isLastFrame = (offset + FRAME_SIZE >= audioBuffer.length);
        const end = Math.min(offset + FRAME_SIZE, audioBuffer.length);
        const chunk = audioBuffer.slice(offset, end);

        const audioFrame = {
          data: {
            status: isLastFrame ? 2 : 1,
            encoding: 'raw',
            data_type: 1,
            data: chunk.toString('base64')
          }
        };

        ws.send(JSON.stringify(audioFrame));
        offset += FRAME_SIZE;

        if (isLastFrame) {
          console.log('音频发送完毕，等待评分...');
          clearInterval(interval);
        }
      }, 40); // 间隔40ms模拟流式发送
    });

    ws.on('message', (data) => {
      const response = JSON.parse(data);
      if (response.code !== 0) {
        console.error('讯飞业务报错:', response.message);
        ws.close();
        return reject(new Error(`讯飞错误(${response.code}): ${response.message}`));
      }
      
      if (response.data && response.data.status === 2) {
        finalResult = response.data;
        ws.close();
        resolve(parseResult(finalResult));
      }
    });

    ws.on('error', (err) => reject(new Error('WebSocket错误: ' + err.message)));
    ws.on('close', () => { if (!finalResult) reject(new Error('讯飞连接断开，未获取到结果')); });
    setTimeout(() => { if (ws.readyState === WebSocket.OPEN) { ws.close(); reject(new Error('超时')); } }, 20000);
  });
}

function parseResult(data) {
  try {
    const resultStr = Buffer.from(data.data, 'base64').toString('utf-8');
    const resultObj = JSON.parse(resultStr);
    const wordInfo = resultObj.read_word?.rec_paper?.read_chapter?.word?.[0] || {};
    return {
      success: true,
      score: Math.round(wordInfo.total_score || 0),
      accuracy: Math.round(wordInfo.accuracy_score || 0),
      fluency: Math.round(wordInfo.fluency_score || 0)
    };
  } catch (e) {
    return { success: false, error: '解析结果失败' };
  }
}
