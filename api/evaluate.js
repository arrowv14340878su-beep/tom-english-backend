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
    if (!audio || !text) return res.status(400).json({ success: false, error: 'Missing audio or text' });
    
    console.log(`[Client] Request received. Word: ${text}, Audio Base64 length: ${audio.length}`);
    const result = await evaluateAudio(audio, text);
    return res.status(200).json(result);
  } catch (error) {
    console.error('[Backend Final Error]', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => res.send('Tom English Backend is Running with Debug Mode.'));
app.listen(process.env.PORT || 8080);

function evaluateAudio(audioBase64, text) {
  return new Promise((resolve, reject) => {
    // 1. 验证环境变量
    if (!XFYUN_CONFIG.APPID || !XFYUN_CONFIG.API_KEY || !XFYUN_CONFIG.API_SECRET) {
      return reject(new Error('Railway环境变量(APPID/KEY/SECRET)未正确配置'));
    }

    const authUrl = getAuthUrl();
    console.log('[iFlytek] Connecting to WS...');
    const ws = new WebSocket(authUrl);
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    let finalResult = null;
    let wsClosed = false;

    const FRAME_SIZE = 5000;
    let offset = 0;

    ws.on('open', () => {
      console.log('[iFlytek] WS Open. Total bytes:', audioBuffer.length);

      const sendNext = () => {
        if (ws.readyState !== WebSocket.OPEN) return;

        const isFirst = (offset === 0);
        const isLast = (offset + FRAME_SIZE >= audioBuffer.length);
        const chunk = audioBuffer.slice(offset, Math.min(offset + FRAME_SIZE, audioBuffer.length));
        
        let frame = {};

        if (isFirst) {
          frame = {
            common: { app_id: XFYUN_CONFIG.APPID },
            business: {
              category: 'read_word',
              sub: 'ise',
              ent: 'en_vip',
              cmd: 'ssb', // 讯飞ISE v2 核心指令
              auf: 'audio/L16;rate=16000',
              aue: 'raw',
              tte: 'utf-8',
              // 按照你的建议：先尝试不加BOM的Base64
              text: Buffer.from(text).toString('base64'),
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
          console.log('[iFlytek] Sending FIRST frame. Business CMD:', frame.business.cmd);
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

        ws.send(JSON.stringify(frame));
        offset += FRAME_SIZE;

        if (!isLast) {
          setTimeout(sendNext, 40);
        } else {
          console.log('[iFlytek] All audio frames sent.');
        }
      };

      sendNext();
    });

    ws.on('message', (data) => {
      try {
        const resp = JSON.parse(data);
        
        // 如果出错，打印讯飞返回的完整 JSON 结构，用于诊断 30002
        if (resp.code !== 0) {
          console.error('[iFlytek] API Error Response:', JSON.stringify(resp, null, 2));
          ws.close();
          return reject(new Error(`讯飞报错(${resp.code}): ${resp.message}`));
        }

        if (resp.data && resp.data.status === 2) {
          finalResult = resp.data;
          console.log('[iFlytek] Final result received.');
          const parsed = parseResult(finalResult);
          wsClosed = true;
          ws.close();
          resolve(parsed);
        }
      } catch (e) {
        console.error('[iFlytek] Message parse error:', e.message);
      }
    });

    ws.on('error', (err) => {
      console.error('[iFlytek] WebSocket Error:', err.message);
      reject(new Error('WS连接失败: ' + err.message));
    });

    ws.on('close', (code, reason) => {
      console.log(`[iFlytek] WS Closed. Code: ${code}, Reason: ${reason}`);
      if (!finalResult) reject(new Error('连接关闭，未获取到评分结果'));
    });

    // 30秒安全超时
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
        reject(new Error('评测超时'));
      }
    }, 30000);
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
      accuracy: Math.round(wordInfo.accuracy_score || 0),
      fluency: Math.round(wordInfo.fluency_score || 0)
    };
  } catch (e) {
    return { success: false, error: '结果解析失败' };
  }
}
