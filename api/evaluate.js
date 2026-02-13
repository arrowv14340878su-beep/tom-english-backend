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
  const signatureOrigin = `host: ${XFYUN_CONFIG.HOST}\r\ndate: ${date}\r\nGET ${XFYUN_CONFIG.URI} HTTP/1.1`;
  const hmac = crypto.createHmac('sha256', XFYUN_CONFIG.API_SECRET);
  const signature = hmac.update(signatureOrigin).digest('base64');
  const authorizationOrigin = `api_key="${XFYUN_CONFIG.API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin).toString('base64');
  return `wss://${XFYUN_CONFIG.HOST}${XFYUN_CONFIG.URI}?authorization=${authorization}&date=${encodeURIComponent(date)}&host=${XFYUN_CONFIG.HOST}`;
}

app.post('/api/evaluate', async (req, res) => {
  try {
    const { audio, text } = req.body;
    // 1. 空音频保护 (建议项 1)
    if (!audio || audio.length === 0) return res.status(400).json({ success: false, error: '音频数据为空' });
    
    console.log(`[TomEnglish] 评测请求: ${text}, 数据大小: ${audio.length}`);
    const result = await evaluateAudio(audio, text);
    return res.status(200).json(result);
  } catch (error) {
    console.error('[TomEnglish Error]', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => res.send('Backend v1.1.0 Gold Stable'));
app.listen(process.env.PORT || 8080);

function evaluateAudio(audioBase64, text) {
  return new Promise((resolve, reject) => {
    let resolvedOrRejected = false;
    const authUrl = getAuthUrl();
    const ws = new WebSocket(authUrl);
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    
    const FRAME_SIZE = 1280; 
    let offset = 0;
    let finalResult = null;

    // 3. WS 心跳检测 (建议项 3)
    let lastMessageTime = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - lastMessageTime > 15000) {
        console.warn('[iFlytek] 连接非正常静默，主动断开');
        ws.terminate();
      }
    }, 5000);

    const cleanup = () => {
      clearInterval(heartbeat);
      resolvedOrRejected = true;
    };

    ws.on('open', () => {
      const sendNextFrame = () => {
        if (ws.readyState !== WebSocket.OPEN) return;

        const isFirst = (offset === 0);
        const chunk = audioBuffer.slice(offset, Math.min(offset + FRAME_SIZE, audioBuffer.length));
        const isLast = (offset + chunk.length >= audioBuffer.length);
        
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
            text: Buffer.from(text).toString('base64')
          };
        }

        ws.send(JSON.stringify(frame));
        offset += chunk.length;

        if (!isLast) {
          setTimeout(sendNextFrame, 40);
        }
      };
      sendNextFrame();
    });

    ws.on('message', (data) => {
      lastMessageTime = Date.now();
      const resp = JSON.parse(data);
      if (resp.code !== 0) {
        cleanup();
        ws.close();
        if (!resolvedOrRejected) reject(new Error(`讯飞报错(${resp.code}): ${resp.message}`));
        return;
      }

      if (resp.data && resp.data.status === 2) {
        finalResult = resp.data;
        cleanup();
        ws.close();
        resolve(parseResult(finalResult));
      }
    });

    ws.on('error', (err) => {
      if (!resolvedOrRejected) {
        cleanup();
        reject(new Error('WebSocket异常'));
      }
    });

    ws.on('close', () => {
      if (!resolvedOrRejected) {
        cleanup();
        reject(new Error('连接已关闭'));
      }
    });
  });
}

function parseResult(data) {
  try {
    const resStr = Buffer.from(data.data, 'base64').toString('utf-8');
    const resObj = JSON.parse(resStr);
    
    // 2. 多重结构兼容解析 (建议项 2)
    const wordBase = resObj.read_word?.rec_paper?.read_chapter || 
                     resObj.read_sentence?.rec_paper?.read_chapter || {};
    
    const word = wordBase.word?.[0] || 
                 wordBase.sentence?.[0]?.word?.[0] || {};
    
    return {
      success: true,
      score: Math.round(word.total_score || wordBase.total_score || 0),
      accuracy: Math.round(word.accuracy_score || 0)
    };
  } catch (e) {
    return { success: false, error: '解析结果异常' };
  }
}
