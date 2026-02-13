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
  // 签名原串：严格遵守讯飞握手协议
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
    console.log(`[TomEnglish] 收到请求: ${text}, 长度: ${audio.length}`);
    const result = await evaluateAudio(audio, text);
    return res.status(200).json(result);
  } catch (error) {
    console.error('[TomEnglish Error]', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => res.send('Backend is Debugging...'));
app.listen(process.env.PORT || 8080);

function evaluateAudio(audioBase64, text) {
  return new Promise((resolve, reject) => {
    let resolvedOrRejected = false;
    const authUrl = getAuthUrl();
    const ws = new WebSocket(authUrl);
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    
    let offset = 0;
    const FRAME_SIZE = 1280;
    let finalResult = null;

    // 定时器检查
    const timeoutTimer = setTimeout(() => {
      if (!resolvedOrRejected) {
        resolvedOrRejected = true;
        ws.terminate();
        reject(new Error('讯飞连接超时'));
      }
    }, 15000);

    ws.on('open', () => {
      console.log('[iFlytek] WS 连接已建立，开始传输...');
      
      const sendNext = () => {
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
            text: Buffer.from('\uFEFF' + text).toString('base64'),
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
        console.error('[iFlytek Error Response]', JSON.stringify(resp));
        if (!resolvedOrRejected) {
          resolvedOrRejected = true;
          ws.close();
          reject(new Error(`讯飞报错(${resp.code}): ${resp.message}`));
        }
      } else if (resp.data && resp.data.status === 2) {
        finalResult = resp.data;
        if (!resolvedOrRejected) {
          resolvedOrRejected = true;
          clearTimeout(timeoutTimer);
          ws.close();
          resolve(parseResult(finalResult));
        }
      }
    });

    ws.on('error', (err) => {
      console.error('[iFlytek WS Error Detail]', err); // 这里的详细日志非常重要！
      if (!resolvedOrRejected) {
        resolvedOrRejected = true;
        clearTimeout(timeoutTimer);
        reject(new Error(`WebSocket异常: ${err.message}`));
      }
    });

    ws.on('close', (code, reason) => {
      if (!resolvedOrRejected) {
        resolvedOrRejected = true;
        clearTimeout(timeoutTimer);
        reject(new Error(`连接已关闭(Code:${code}, Reason:${reason})`));
      }
    });
  });
}

function parseResult(data) {
  try {
    const resStr = Buffer.from(data.data, 'base64').toString('utf-8');
    const resObj = JSON.parse(resStr);
    const word = resObj.read_word?.rec_paper?.read_chapter?.word?.[0] || {};
    return { success: true, score: Math.round(word.total_score || 0) };
  } catch (e) {
    return { success: false, error: '解析结果失败' };
  }
}
