// 音频录制器 - Content Script
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let videoElement = null;
let audioContext = null;
let sourceNode = null;
let destinationNode = null;
let mediaStreamDestination = null;

// 无损录制相关变量
let useLosslessRecording = true; // 默认使用无损录制
let audioWorkletNode = null;
let pcmAudioData = [];
let scriptProcessorNode = null;

// 字幕捕获相关变量
let subtitleCaptureMode = false;
let subtitleCaptureMonitor = null;
let capturedSubtitles = [];
let lastSubtitleText = '';
let videoStartTime = 0;
let currentBvid = null;

// 从URL中提取BV号
function extractBvidFromUrl() {
  const url = window.location.href;
  const bvidMatch = url.match(/\/video\/(BV[^/?]+)/);
  return bvidMatch ? bvidMatch[1] : null;
}

// 检查是否在B站视频页面（有BV号）
function checkBvidAndLoad() {
  const bvid = extractBvidFromUrl();
  if (!bvid) {
    console.log('未检测到BV号，插件不加载');
    return false;
  }
  
  currentBvid = bvid;
  console.log('检测到BV号:', bvid);
  return true;
}

// 初始化：检查BV号
if (!checkBvidAndLoad()) {
  // 如果没有BV号，监听URL变化
  let lastUrl = window.location.href;
  const urlCheckInterval = setInterval(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      if (checkBvidAndLoad()) {
        clearInterval(urlCheckInterval);
        // 重新初始化
        setupVideoListeners();
      }
    }
  }, 1000);
  
  // 如果10秒后还没有BV号，停止检查
  setTimeout(() => {
    clearInterval(urlCheckInterval);
  }, 10000);
}

// 查找页面中的视频元素
function findVideoElement() {
  const videos = document.querySelectorAll('video');
  if (videos.length > 0) {
    return videos[0]; // 返回第一个视频元素
  }
  return null;
}

// 格式化时间为SRT格式 (HH:MM:SS,mmm)
function formatTimeForSRT(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const milliseconds = Math.floor((seconds % 1) * 1000);
  
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${milliseconds.toString().padStart(3, '0')}`;
}

// 去重字幕（基于文本内容和时间戳）
function deduplicateSubtitles(subtitles) {
  const seen = new Map(); // 使用Map存储已见过的字幕（文本+时间戳）
  const unique = [];
  
  for (const subtitle of subtitles) {
    const text = subtitle.text || '';
    const timestamp = subtitle.timestamp || 0;
    
    // 创建唯一键（文本+时间戳，允许相同文本在不同时间出现）
    // 但如果文本相同且时间戳非常接近（1秒内），认为是重复的
    const key = `${text}_${Math.floor(timestamp)}`;
    
    if (!seen.has(key)) {
      seen.set(key, true);
      unique.push(subtitle);
    } else {
      // 检查是否是真正的重复（文本相同且时间戳接近）
      const existing = unique.find(s => 
        s.text === text && 
        Math.abs(s.timestamp - timestamp) < 1.0
      );
      if (!existing) {
        unique.push(subtitle);
      }
    }
  }
  
  return unique;
}

// 生成SRT格式字幕
function generateSRTSubtitles(subtitles) {
  if (!subtitles || subtitles.length === 0) {
    return '';
  }
  
  // 去重处理
  const uniqueSubtitles = deduplicateSubtitles(subtitles);
  
  // 按时间戳排序
  uniqueSubtitles.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  
  let srtContent = '';
  
  uniqueSubtitles.forEach((subtitle, index) => {
    const startTime = formatTimeForSRT(subtitle.timestamp || 0);
    // 计算结束时间（下一个字幕的开始时间，或当前时间+3秒）
    let endTime;
    if (index < uniqueSubtitles.length - 1) {
      endTime = formatTimeForSRT(uniqueSubtitles[index + 1].timestamp || subtitle.timestamp + 3);
    } else {
      endTime = formatTimeForSRT((subtitle.timestamp || 0) + 3);
    }
    
    srtContent += `${index + 1}\n`;
    srtContent += `${startTime} --> ${endTime}\n`;
    srtContent += `${subtitle.text}\n\n`;
  });
  
  return srtContent;
}

// 启动字幕捕获
function startSubtitleCapture() {
  try {
    console.log('🎬 启动字幕捕获...');
    
    if (subtitleCaptureMode) {
      console.log('字幕捕获已在运行中');
      return;
    }
    
    // 重置状态
    capturedSubtitles = [];
    lastSubtitleText = '';
    subtitleCaptureMode = true;
    
    // 获取视频元素
    const video = document.querySelector('video');
    if (!video) {
      console.log('未找到视频元素');
      return;
    }
    
    // 记录开始时间
    videoStartTime = video.currentTime;
    
    // 开始监控字幕
    startSubtitleMonitoring();
    
    console.log('✅ 字幕捕获已启动');
  } catch (error) {
    console.error('启动字幕捕获失败:', error);
    subtitleCaptureMode = false;
  }
}

// 停止字幕捕获
function stopSubtitleCapture() {
  try {
    console.log('🛑 停止字幕捕获...');
    
    subtitleCaptureMode = false;
    
    if (subtitleCaptureMonitor) {
      clearInterval(subtitleCaptureMonitor);
      subtitleCaptureMonitor = null;
    }
    
    console.log('✅ 字幕捕获已停止，共捕获', capturedSubtitles.length, '条字幕');
  } catch (error) {
    console.error('停止字幕捕获失败:', error);
  }
}

// 开始监控字幕
function startSubtitleMonitoring() {
  console.log('👀 开始监控字幕内容...');
  
  subtitleCaptureMonitor = setInterval(() => {
    monitorSubtitleContent();
  }, 200); // 每200ms检查一次字幕内容，提高捕获频率
}

// 过滤无用文本
function isFilteredText(text) {
  const filterKeywords = [
    'ai原声翻译',
    'ai原声翻译（beta）',
    'ai原声翻译(beta)',
    'ai原声翻译（beta',
    'ai原声翻译(beta',
    '原声翻译',
    'ai小助手',
    '测试版',
    '加载中',
    'loading',
    '播放器',
    '视频',
    '暂停',
    '播放',
    '全屏',
    '音量',
    '设置',
    '分享',
    '收藏',
    '点赞',
    '投币',
    '关注',
    '弹幕',
    '字幕',
    '清晰度',
    'beta',
    'beta)',
    '（beta）',
    '(beta)'
  ];
  
  const normalizedText = text.toLowerCase().trim();
  return filterKeywords.some(keyword => normalizedText.includes(keyword));
}

// 清理字幕文本
function cleanSubtitleText(text) {
  if (!text) return '';
  
  // 移除首尾空白
  let cleaned = text.trim();
  
  // 移除"AI原声翻译（Beta）"等系统提示（从开头或结尾）
  cleaned = cleaned.replace(/^AI原声翻译[（(]?Beta[）)]?\s*/i, '');
  cleaned = cleaned.replace(/\s*AI原声翻译[（(]?Beta[）)]?$/i, '');
  cleaned = cleaned.replace(/^原声翻译[（(]?Beta[）)]?\s*/i, '');
  cleaned = cleaned.replace(/\s*原声翻译[（(]?Beta[）)]?$/i, '');
  cleaned = cleaned.replace(/^AI原声翻译\s*/i, '');
  cleaned = cleaned.replace(/\s*AI原声翻译$/i, '');
  cleaned = cleaned.replace(/^原声翻译\s*/i, '');
  cleaned = cleaned.replace(/\s*原声翻译$/i, '');
  
  // 移除文本中间的"AI原声翻译（Beta）"（前后有空格的情况）
  cleaned = cleaned.replace(/\s+AI原声翻译[（(]?Beta[）)]?\s+/gi, ' ');
  cleaned = cleaned.replace(/\s+原声翻译[（(]?Beta[）)]?\s+/gi, ' ');
  
  // 移除多余的空白行和空白字符
  cleaned = cleaned.replace(/\n\s*\n/g, '\n');
  cleaned = cleaned.replace(/\s+/g, ' '); // 多个连续空格替换为单个空格
  cleaned = cleaned.trim();
  
  return cleaned;
}

// 监控字幕内容
function monitorSubtitleContent() {
  try {
    if (!subtitleCaptureMode) return;
    
    // 查找字幕元素（尝试多个选择器）
    let subtitleElement = document.querySelector('.bili-subtitle-x-subtitle-panel-text');
    
    // 如果主选择器找不到，尝试备用选择器
    if (!subtitleElement) {
      const alternativeSelectors = [
        '.bpx-player-subtitle-text',
        '.bpx-player-subtitle-panel-text',
        '[class*="subtitle"] [class*="text"]',
        '[class*="Subtitle"] [class*="Text"]'
      ];
      
      for (const selector of alternativeSelectors) {
        subtitleElement = document.querySelector(selector);
        if (subtitleElement) {
          console.log(`使用备用选择器找到字幕元素: ${selector}`);
          break;
        }
      }
    }
    
    if (subtitleElement) {
      // 获取所有文本内容（包括子元素，处理多行字幕）
      let currentText = '';
      
      // 方法1: 尝试获取所有直接子元素的文本（处理多行字幕）
      const childElements = subtitleElement.children;
      if (childElements.length > 0) {
        const texts = [];
        for (let i = 0; i < childElements.length; i++) {
          const childText = childElements[i].textContent.trim();
          if (childText && childText.length > 0) {
            texts.push(childText);
          }
        }
        if (texts.length > 0) {
          currentText = texts.join(' ').trim();
        }
      }
      
      // 方法2: 如果方法1没有结果，尝试获取所有文本节点
      if (!currentText) {
        const textNodes = [];
        const walker = document.createTreeWalker(
          subtitleElement,
          NodeFilter.SHOW_TEXT,
          null,
          false
        );
        
        let node;
        while ((node = walker.nextNode())) {
          const text = node.textContent.trim();
          if (text && text.length > 0 && !isFilteredText(text)) {
            textNodes.push(text);
          }
        }
        
        if (textNodes.length > 0) {
          currentText = textNodes.join(' ').trim();
        }
      }
      
      // 方法3: 如果前两种方法都没有结果，使用textContent作为后备
      if (!currentText) {
        currentText = subtitleElement.textContent.trim();
      }
      
      // 清理文本（在检查之前清理，但保留原始文本用于比较）
      const originalText = currentText;
      currentText = cleanSubtitleText(currentText);
      
      // 如果清理后文本为空但原始文本不为空，可能是清理过度了，使用原始文本
      if (!currentText && originalText && originalText.length > 0) {
        currentText = originalText;
      }
      
      const video = document.querySelector('video');
      const currentTime = video ? video.currentTime : 0;
      
      // 检查文本是否有效
      if (currentText && 
          currentText !== lastSubtitleText && 
          currentText.length > 0 &&
          !isFilteredText(currentText) &&
          currentText.length >= 1) { // 至少1个字符
        
        console.log(`📝 捕获字幕 [${formatTimeForSRT(currentTime)}]: ${currentText}`);
        
        // 添加到捕获列表
        capturedSubtitles.push({
          text: currentText,
          timestamp: currentTime
        });
        
        // 更新最后字幕内容
        lastSubtitleText = currentText;
      }
    }
    
    // 检查视频是否结束
    const video = document.querySelector('video');
    if (video && video.ended) {
      console.log('🎬 视频播放结束，停止字幕捕获');
      stopSubtitleCapture();
    }
    
  } catch (error) {
    console.error('监控字幕内容失败:', error);
  }
}

// 初始化音频录制
async function startRecording() {
  try {
    // 检查BV号
    if (!currentBvid) {
      currentBvid = extractBvidFromUrl();
      if (!currentBvid) {
        console.log('未检测到BV号，无法录制');
        sendMessage({ type: 'error', message: '未检测到BV号，请在B站视频页面使用' });
        return;
      }
    }
    
    videoElement = findVideoElement();
    if (!videoElement) {
      console.log('未找到视频元素');
      sendMessage({ type: 'error', message: '未找到视频元素' });
      return;
    }

    // 启动字幕捕获
    startSubtitleCapture();

    // 创建音频上下文
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    // 创建MediaElementAudioSourceNode来捕获视频的音频
    sourceNode = audioContext.createMediaElementSource(videoElement);
    
    // 连接到destination，保持音频播放
    sourceNode.connect(audioContext.destination);
    
    if (useLosslessRecording) {
      // 使用无损录制：直接捕获PCM数据
      console.log('🎵 使用无损录制模式（PCM -> WAV）');
      startLosslessRecording();
    } else {
      // 使用有损录制：MediaRecorder
      console.log('🎵 使用有损录制模式（Opus）');
      startLossyRecording();
    }
    
    
  } catch (error) {
    console.error('启动录制失败:', error);
    sendMessage({ type: 'error', message: '启动录制失败: ' + error.message });
    stopSubtitleCapture();
    cleanup();
  }
}

// 启动无损录制（PCM）
function startLosslessRecording() {
  try {
    // 重置PCM数据
    pcmAudioData = [];
    
    // 使用ScriptProcessorNode捕获PCM数据（已废弃但兼容性好）
    // 或者使用AudioWorklet（需要单独的worklet文件，更复杂）
    const bufferSize = 4096;
    const numberOfInputChannels = 2;
    const numberOfOutputChannels = 2;
    
    // 检查是否支持ScriptProcessorNode
    if (audioContext.createScriptProcessor) {
      scriptProcessorNode = audioContext.createScriptProcessor(
        bufferSize,
        numberOfInputChannels,
        numberOfOutputChannels
      );
      
      scriptProcessorNode.onaudioprocess = (event) => {
        if (!isRecording) return;
        
        const inputBuffer = event.inputBuffer;
        const outputBuffer = event.outputBuffer;
        
        // 复制输入到输出（保持播放）
        for (let channel = 0; channel < outputBuffer.numberOfChannels; channel++) {
          const inputData = inputBuffer.getChannelData(channel);
          const outputData = outputBuffer.getChannelData(channel);
          outputData.set(inputData);
        }
        
        // 保存PCM数据
        const leftChannel = inputBuffer.getChannelData(0);
        const rightChannel = inputBuffer.numberOfChannels > 1 
          ? inputBuffer.getChannelData(1) 
          : leftChannel;
        
        // 转换为Int16Array
        const length = leftChannel.length;
        const pcm16 = new Int16Array(length * 2);
        
        for (let i = 0; i < length; i++) {
          // 左声道
          const sampleL = Math.max(-1, Math.min(1, leftChannel[i]));
          pcm16[i * 2] = sampleL < 0 ? sampleL * 0x8000 : sampleL * 0x7FFF;
          
          // 右声道（或复制左声道）
          const sampleR = Math.max(-1, Math.min(1, rightChannel[i]));
          pcm16[i * 2 + 1] = sampleR < 0 ? sampleR * 0x8000 : sampleR * 0x7FFF;
        }
        
        pcmAudioData.push({
          data: pcm16,
          sampleRate: audioContext.sampleRate,
          channels: inputBuffer.numberOfChannels
        });
      };
      
      // 连接节点
      sourceNode.connect(scriptProcessorNode);
      scriptProcessorNode.connect(audioContext.destination);
      
      isRecording = true;
      sendMessage({ type: 'recordingStarted' });
      console.log('✅ 无损录制已启动（PCM）');
    } else {
      console.warn('ScriptProcessorNode不支持，回退到有损录制');
      startLossyRecording();
    }
  } catch (error) {
    console.error('启动无损录制失败:', error);
    console.log('回退到有损录制');
    startLossyRecording();
  }
}

// 启动有损录制（MediaRecorder）
function startLossyRecording() {
  try {
    // 创建MediaStreamDestination用于捕获音频
    mediaStreamDestination = audioContext.createMediaStreamDestination();
    
    // 连接到MediaStreamDestination
    sourceNode.connect(mediaStreamDestination);
    
    // 使用MediaRecorder录制音频流
    const options = {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 256000 // 提高码率以获得更好音质
    };
    
    // 检查浏览器是否支持该格式
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options.mimeType = 'audio/webm';
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options.mimeType = 'audio/ogg;codecs=opus';
      }
    }
    
    mediaRecorder = new MediaRecorder(mediaStreamDestination.stream, options);
    audioChunks = [];
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };
    
    mediaRecorder.onstop = async () => {
      await handleRecordingStop();
    };
    
    mediaRecorder.onerror = (event) => {
      console.error('录制错误:', event.error);
      sendMessage({ type: 'error', message: '录制过程中发生错误' });
      stopSubtitleCapture();
      cleanup();
    };
    
    mediaRecorder.start(1000); // 每1秒收集一次数据
    isRecording = true;
    sendMessage({ type: 'recordingStarted' });
    console.log('✅ 有损录制已启动（Opus）');
  } catch (error) {
    console.error('启动有损录制失败:', error);
    sendMessage({ type: 'error', message: '启动录制失败: ' + error.message });
    cleanup();
  }
}

// 处理录制停止（统一处理）
async function handleRecordingStop() {
  console.log('录制停止，开始处理音频数据...');
  
  // 停止字幕捕获
  stopSubtitleCapture();
  
  try {
    let finalBlob;
    let extension = 'wav';
    let mimeType = 'audio/wav';
    
    if (useLosslessRecording && pcmAudioData.length > 0) {
      // 无损录制：从PCM数据生成WAV
      console.log('处理无损PCM数据...');
      finalBlob = await convertPCMToWAV(pcmAudioData);
      console.log('WAV文件生成成功，大小:', finalBlob.size, '字节');
    } else if (mediaRecorder && audioChunks.length > 0) {
      // 有损录制：处理MediaRecorder数据
      const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
      console.log('音频Blob大小:', audioBlob.size, '字节');
      
      if (audioBlob.size === 0) {
        throw new Error('录制的音频数据为空');
      }
      
      // 尝试转换为WAV格式
      try {
        console.log('开始转换为WAV格式...');
        finalBlob = await convertToWav(audioBlob);
        console.log('WAV转换成功，大小:', finalBlob.size, '字节');
      } catch (conversionError) {
        console.log('转换为WAV失败，使用原始格式:', conversionError);
        finalBlob = audioBlob;
        if (mediaRecorder.mimeType.includes('ogg')) {
          extension = 'ogg';
          mimeType = mediaRecorder.mimeType;
        } else {
          extension = 'webm';
          mimeType = mediaRecorder.mimeType;
        }
      }
    } else {
      throw new Error('没有录制数据');
    }
    
    // 生成SRT字幕
    const srtContent = generateSRTSubtitles(capturedSubtitles);
    console.log('SRT字幕生成完成，共', capturedSubtitles.length, '条');
    
    // 生成文件名
    const bvid = currentBvid || extractBvidFromUrl() || 'unknown';
    const audioFilename = `${bvid}.${extension}`;
    const subtitleFilename = `${bvid}.srt`;
    
    // 在content script中直接下载音频文件
    console.log('准备下载音频文件:', audioFilename);
    downloadFileInPage(finalBlob, audioFilename, mimeType);
    
    // 下载字幕文件
    if (srtContent && srtContent.length > 0) {
      console.log('准备下载字幕文件:', subtitleFilename);
      const subtitleBlob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
      downloadFileInPage(subtitleBlob, subtitleFilename, 'text/plain;charset=utf-8');
    }
    
    // 发送成功消息给background script
    sendMessage({
      type: 'downloadComplete',
      bvid: bvid,
      audioFilename: audioFilename,
      subtitleFilename: subtitleFilename,
      subtitleCount: capturedSubtitles.length,
      audioSize: finalBlob.size,
      isLossless: useLosslessRecording
    });
    console.log('文件下载完成');
    
  } catch (error) {
    console.error('处理音频数据失败:', error);
    sendMessage({ type: 'error', message: '处理音频数据失败: ' + error.message });
  }
  
  // 清理
  cleanup();
}

// 将PCM数据转换为WAV
async function convertPCMToWAV(pcmDataArray) {
  if (!pcmDataArray || pcmDataArray.length === 0) {
    throw new Error('PCM数据为空');
  }
  
  // 获取采样率和声道数（假设所有数据块相同）
  const sampleRate = pcmDataArray[0].sampleRate;
  const numberOfChannels = pcmDataArray[0].channels;
  
  // 计算总长度
  let totalLength = 0;
  for (const chunk of pcmDataArray) {
    totalLength += chunk.data.length;
  }
  
  // 合并所有PCM数据
  const mergedPCM = new Int16Array(totalLength);
  let offset = 0;
  for (const chunk of pcmDataArray) {
    mergedPCM.set(chunk.data, offset);
    offset += chunk.data.length;
  }
  
  // 计算WAV文件大小
  const bytesPerSample = 2;
  const blockAlign = numberOfChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = mergedPCM.length * bytesPerSample;
  const bufferSize = 44 + dataSize;
  
  // 创建WAV文件
  const arrayBuffer = new ArrayBuffer(bufferSize);
  const view = new DataView(arrayBuffer);
  
  // WAV文件头
  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };
  
  writeString(0, 'RIFF');
  view.setUint32(4, bufferSize - 8, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // audio format (1 = PCM)
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  
  // 写入PCM数据
  let dataOffset = 44;
  for (let i = 0; i < mergedPCM.length; i++) {
    view.setInt16(dataOffset, mergedPCM[i], true);
    dataOffset += 2;
  }
  
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

// 停止录制
function stopRecording() {
  if (isRecording) {
    if (useLosslessRecording && scriptProcessorNode) {
      // 停止无损录制
      isRecording = false;
      stopSubtitleCapture();
      handleRecordingStop();
      sendMessage({ type: 'recordingStopped' });
      console.log('停止录制音频和字幕（无损）');
    } else if (mediaRecorder) {
      // 停止有损录制
      mediaRecorder.stop();
      isRecording = false;
      stopSubtitleCapture();
      sendMessage({ type: 'recordingStopped' });
      console.log('停止录制音频和字幕（有损）');
    }
  }
}

// 清理资源
function cleanup() {
  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch (e) {}
    sourceNode = null;
  }
  
  if (scriptProcessorNode) {
    try {
      scriptProcessorNode.disconnect();
      scriptProcessorNode.onaudioprocess = null;
    } catch (e) {}
    scriptProcessorNode = null;
  }
  
  if (mediaStreamDestination) {
    try {
      mediaStreamDestination.disconnect();
    } catch (e) {}
    mediaStreamDestination = null;
  }
  
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.stop();
    } catch (e) {}
    mediaRecorder = null;
  }
  
  audioChunks = [];
  pcmAudioData = [];
  
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close().catch(console.error);
    audioContext = null;
  }
  
  isRecording = false;
}

// 跳转到视频第0秒并开始录制
async function jumpToStartAndRecord() {
  try {
    // 检查BV号
    if (!currentBvid) {
      currentBvid = extractBvidFromUrl();
      if (!currentBvid) {
        console.log('未检测到BV号');
        sendMessage({ type: 'error', message: '未检测到BV号，请在B站视频页面使用' });
        return false;
      }
    }
    
    videoElement = findVideoElement();
    if (!videoElement) {
      console.log('未找到视频元素');
      sendMessage({ type: 'error', message: '未找到视频元素' });
      return false;
    }
    
    console.log('⏪ 跳转到视频第0秒...');
    // 跳转到第0秒
    videoElement.currentTime = 0;
    
    // 等待视频跳转完成
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // 如果视频暂停，开始播放
    if (videoElement.paused) {
      console.log('▶️ 开始播放视频...');
      await videoElement.play();
      // 等待播放开始
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // 开始录制
    console.log('🎬 开始录制音频和字幕...');
    await startRecording();
    
    return true;
  } catch (error) {
    console.error('跳转并开始录制失败:', error);
    sendMessage({ type: 'error', message: '跳转并开始录制失败: ' + error.message });
    return false;
  }
}

// 监听视频播放事件（仅监听结束和错误，不自动开始录制）
function setupVideoListeners() {
  // 检查BV号
  if (!currentBvid) {
    currentBvid = extractBvidFromUrl();
    if (!currentBvid) {
      console.log('未检测到BV号，跳过设置视频监听器');
      return;
    }
  }
  
  videoElement = findVideoElement();
  if (!videoElement) {
    return;
  }
  
  // 监听视频结束
  videoElement.addEventListener('ended', () => {
    if (isRecording) {
      stopRecording();
    }
  });
  
  // 监听视频错误
  videoElement.addEventListener('error', () => {
    if (isRecording) {
      stopRecording();
    }
  });
}

// 生成文件名（使用BV号）
function generateFilename(extension) {
  const bvid = currentBvid || extractBvidFromUrl() || 'unknown';
  return `${bvid}.${extension}`;
}

// 将Blob转换为ArrayBuffer
function blobToArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
}

// 将Blob转换为base64字符串（用于消息传递）
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // 移除data URL前缀，只保留base64数据
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// 将音频Blob转换为WAV格式
async function convertToWav(audioBlob) {
  const arrayBuffer = await blobToArrayBuffer(audioBlob);
  
  // 使用新的AudioContext（如果之前的已关闭）
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  
  // 将AudioBuffer转换为WAV格式
  const wav = audioBufferToWav(audioBuffer);
  return new Blob([wav], { type: 'audio/wav' });
}

// 将AudioBuffer转换为WAV格式的ArrayBuffer
function audioBufferToWav(buffer) {
  const length = buffer.length;
  const numberOfChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = 2;
  const blockAlign = numberOfChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = length * blockAlign;
  const bufferSize = 44 + dataSize;
  
  const arrayBuffer = new ArrayBuffer(bufferSize);
  const view = new DataView(arrayBuffer);
  
  // WAV文件头
  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };
  
  writeString(0, 'RIFF');
  view.setUint32(4, bufferSize - 8, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // audio format (1 = PCM)
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  
  // 写入音频数据
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
  }
  
  return arrayBuffer;
}

// 在页面中下载文件
function downloadFileInPage(blob, filename, mimeType) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    // 延迟释放URL，确保下载开始
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 100);
    
    console.log(`✅ 文件下载已启动: ${filename}`);
  } catch (error) {
    console.error('下载文件失败:', error);
    // 如果直接下载失败，尝试通过background script下载
    blobToBase64(blob).then(base64 => {
      chrome.runtime.sendMessage({
        type: 'downloadFile',
        data: base64,
        filename: filename,
        mimeType: mimeType
      }).catch(err => {
        console.error('通过background下载失败:', err);
      });
    }).catch(err => {
      console.error('转换为base64失败:', err);
    });
  }
}

// 发送消息给background script
function sendMessage(message) {
  chrome.runtime.sendMessage(message).catch(err => {
    console.error('发送消息失败:', err);
  });
}

// 监听来自popup或background的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'startCapture') {
    // 开始捕获：跳转到第0秒并开始录制
    jumpToStartAndRecord().then(success => {
      sendResponse({ success: success });
    });
    return true; // 异步响应
  } else if (request.type === 'startRecording') {
    // 兼容旧版本
    startRecording();
    sendResponse({ success: true });
  } else if (request.type === 'stopRecording') {
    stopRecording();
    sendResponse({ success: true });
  } else if (request.type === 'getStatus') {
    const bvid = currentBvid || extractBvidFromUrl();
    sendResponse({ 
      isRecording, 
      hasVideo: !!findVideoElement(),
      hasBvid: !!bvid,
      bvid: bvid
    });
  }
  return true;
});

// 页面加载完成后设置监听器
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    if (checkBvidAndLoad()) {
      setupVideoListeners();
    }
  });
} else {
  if (checkBvidAndLoad()) {
    setupVideoListeners();
  }
}

// 如果视频是动态加载的，定期检查
setInterval(() => {
  if (!videoElement || !document.contains(videoElement)) {
    if (checkBvidAndLoad()) {
      videoElement = findVideoElement();
      if (videoElement) {
        setupVideoListeners();
      }
    }
  }
}, 2000);
