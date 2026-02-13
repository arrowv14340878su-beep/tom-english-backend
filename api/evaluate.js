const crypto = require('crypto');
const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');

const app = express();

// 允许跨域和处理大数据包
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 从环境变量获取讯飞配置
const XFYUN_CONFIG = {
  APPID: process.env.XFYUN_APPID,
  API_SECRET: process.env.XFYUN_API_SECRET,
  API_KEY: process.env.XFYUN_API_KEY,
  HOST: 'ise-api.xfyun.cn',
  URI: '/v2/open-ise'
};

// 生成讯飞鉴权 URL
function getAuthUrl() {
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${XFYUN_CONFIG.HOST}\ndate: ${date}\nGET ${XFYUN_CONFIG.URI} HTTP/1.1`;
  const hmac = crypto.createHmac('sha256', XFYUN_CONFIG.API_SECRET);
  const signature = hmac.update(signatureOrigin).digest('base64');
  const authorizationOrigin = `api_key="${XFYUN_CONFIG.API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin).toString('base64');
  return `wss://${XFYUN_CONFIG.HOST}${XFYUN_CONFIG.URI}?authorization=${authorization}&date=${encodeURIComponent(date)}&host=${XFYUN_CONFIG.HOST}`;
}

// 评测路由
app.post('/api/evaluate', async (req, res) => {
  try {
    const { audio, text } = req.body;
    if (!audio || !text) {
      return res.status(400).json({ success: false, error: '缺少音频数据或文本内容' });
    }

    if (!XFYUN_CONFIG.APPID || !XFYUN_CONFIG.API_SECRET || !XFYUN_CONFIG.API_KEY) {
      return res.status(500).json({ success: false, error: '服务器环境变量未配置' });
    }

    console.log(`收到评测请求，单词: ${text}, 音频长度: ${audio.length}`);
    const result = await evaluateAudio(audio, text);
    return res.status(200).json(result);

  } catch (error) {
    console.error('评测过程出错:', error.message);
    return res.status(500).json({ 
      success: false, 
      error: '评测失败', 
      message: error.message 
    });
  }
});

// 健康检查
app.get('/', (req, res) => res.send('Tom English Backend is Running!'));

// 监听端口
const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => {
  console.log(`服务器启动成功，监听端口: ${port}`);
});

// 调用讯飞 API
function evaluateAudio(audioBase64, text) {
  return new Promise((resolve, reject) => {
    const wsUrl = getAuthUrl();
    const ws = new WebSocket(wsUrl);
    let finalResult = null;

    ws.on('open', () => {
      // 这里的结构必须非常精确
      const params = {
        common: { app_id: XFYUN_CONFIG.APPID },
        business: {
          category: 'read_word', // 读单词模式
          sub: 'ise',
          ent: 'en_vip',
          cmd: 'ssb',
          auf: 'audio/L16;rate=16000',
          aue: 'raw',
          text: Buffer.from('\uFEFF' + text).toString('base64'), // 讯飞要求文本加BOM头
          ttp_skip: true,
          aus: 1
        },
        data: {
          status: 2, // 直接发送完整数据
          encoding: 'raw',
          data_type: 1,
          data: audioBase64 // 【修复点】这里字段名必须叫 data，不能叫 audio
        }
      };
      ws.send(JSON.stringify(params));
    });

    ws.on('message', (data) => {
      const response = JSON.parse(data);
      if (response.code !== 0) {
        ws.close();
        reject(new Error(`讯飞API错误(${response.code}): ${response.message}`));
        return;
      }
      
      if (response.data && response.data.status === 2) {
        finalResult = response.data;
        ws.close();
        const parsed = parseResult(finalResult);
        resolve(parsed);
      }
    });

    ws.on('error', (err) => reject(new Error('WebSocket连接失败: ' + err.message)));
    ws.on('close', () => {
      if (!finalResult) reject(new Error('讯飞连接意外关闭，未返回结果'));
    });

    // 15秒超时
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
        reject(new Error('讯飞响应超时'));
      }
    }, 15000);
  });
}

// 解析讯飞返回的 XML/JSON 结果
function parseResult(data) {
  try {
    const resultStr = Buffer.from(data.data, 'base64').toString('utf-8');
    const resultObj = JSON.parse(resultStr);
    
    // 讯飞ISE结果嵌套非常深，这里根据标准read_word结构取值
    const scoreInfo = resultObj.read_word?.rec_paper?.read_chapter?.word?.[0] || {};
    
    return {
      success: true,
      score: Math.round(scoreInfo.total_score || 0),
      accuracy: Math.round(scoreInfo.accuracy_score || 0),
      fluency: Math.round(scoreInfo.fluency_score || 0),
      details: resultObj
    };
  } catch (error) {
    console.error('结果解析失败:', error);
    return { success: false, error: '无法解析AI返回的结果' };
  }
}
