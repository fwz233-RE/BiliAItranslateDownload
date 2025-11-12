// 音频录制器 - Background Service Worker

// 监听来自content script的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'downloadComplete') {
    console.log('收到下载完成消息');
    handleDownloadComplete(
      request.bvid,
      request.audioFilename,
      request.subtitleFilename,
      request.subtitleCount,
      request.audioSize,
      request.isLossless
    );
    sendResponse({ success: true });
  } else if (request.type === 'downloadFile') {
    // 备用下载方法（如果content script直接下载失败）
    console.log('收到downloadFile消息（备用方法）');
    handleFileDownload(request.data, request.filename, request.mimeType);
    sendResponse({ success: true });
  } else if (request.type === 'audioAndSubtitleReady') {
    // 兼容旧版本（已废弃，因为数据太大）
    console.log('收到audioAndSubtitleReady消息（已废弃）');
    sendResponse({ success: false, error: '数据太大，请使用新版本' });
  } else if (request.type === 'audioReady') {
    // 兼容旧版本
    console.log('收到audioReady消息（旧版本）');
    handleAudioSave(request.audioData, request.mimeType, request.filename);
    sendResponse({ success: true });
  } else if (request.type === 'recordingStarted') {
    console.log('录制已开始');
    // 可以在这里更新badge或通知
    if (sender.tab && sender.tab.id) {
      chrome.action.setBadgeText({ text: '●', tabId: sender.tab.id });
      chrome.action.setBadgeBackgroundColor({ color: '#ff0000' });
    }
  } else if (request.type === 'recordingStopped') {
    console.log('录制已停止');
    if (sender.tab && sender.tab.id) {
      chrome.action.setBadgeText({ text: '', tabId: sender.tab.id });
    }
  } else if (request.type === 'error') {
    console.error('错误:', request.message);
    // 显示通知
    showNotification('音频录制器', request.message || '发生未知错误', 'basic');
  }
  return true;
});

// 显示通知（统一处理）
function showNotification(title, message, type = 'basic') {
  if (!chrome.notifications) {
    console.log('通知API不可用');
    return;
  }
  
  // 直接创建通知，不使用图标（避免图标不存在的问题）
  chrome.notifications.create({
    type: type,
    title: title,
    message: message
  }).catch(err => {
    console.error('创建通知失败:', err);
  });
}

// 处理下载完成
function handleDownloadComplete(bvid, audioFilename, subtitleFilename, subtitleCount, audioSize, isLossless) {
  try {
    console.log('下载完成:', {
      bvid: bvid,
      audioFilename: audioFilename,
      subtitleFilename: subtitleFilename,
      subtitleCount: subtitleCount,
      audioSize: audioSize,
      isLossless: isLossless
    });
    
    const qualityText = isLossless ? '无损（PCM/WAV）' : '有损（Opus）';
    const message = `文件已保存！\n音频: ${audioFilename} (${(audioSize / 1024 / 1024).toFixed(2)} MB)\n格式: ${qualityText}\n字幕: ${subtitleFilename} (${subtitleCount}条)`;
    showNotification('音频录制完成', message, 'basic');
  } catch (error) {
    console.error('处理下载完成失败:', error);
  }
}

// 处理文件下载（备用方法）
function handleFileDownload(dataBase64, filename, mimeType) {
  try {
    const dataUrl = `data:${mimeType};base64,${dataBase64}`;
    downloadFile(dataUrl, filename, `文件已保存: ${filename}`);
  } catch (error) {
    console.error('处理文件下载失败:', error);
    showNotification('下载失败', '保存文件时发生错误: ' + (error.message || String(error)), 'basic');
  }
}

// 处理音频和字幕保存（已废弃，因为数据太大）
async function handleAudioAndSubtitleSave(audioDataBase64, subtitleData, mimeType, bvid, subtitleCount) {
  console.warn('handleAudioAndSubtitleSave已废弃，数据太大无法通过消息传递');
  // 这个方法不再使用，因为音频数据太大
}

// 处理音频保存（兼容旧版本）
async function handleAudioSave(audioDataBase64, mimeType, filename) {
  try {
    console.log('收到音频数据，开始保存...');
    console.log('MIME类型:', mimeType);
    console.log('文件名:', filename);
    console.log('Base64数据长度:', audioDataBase64 ? audioDataBase64.length : 0);
    
    if (!audioDataBase64 || audioDataBase64.length === 0) {
      throw new Error('音频数据为空');
    }
    
    // 根据mimeType决定文件扩展名和提示信息
    let extension = 'wav';
    let successMessage = 'WAV格式已保存，您可以使用音频转换工具将其转换为MP3';
    
    if (mimeType.includes('wav')) {
      extension = 'wav';
      successMessage = 'WAV格式已保存，您可以使用音频转换工具将其转换为MP3';
    } else if (mimeType.includes('ogg')) {
      extension = 'ogg';
      successMessage = 'OGG格式已保存';
    } else {
      extension = 'webm';
      successMessage = 'WEBM格式已保存';
    }
    
    // 修改文件名为正确的扩展名
    const finalFilename = filename.replace(/\.(mp3|wav|webm|ogg)$/, `.${extension}`);
    
    // 创建data URL（audioDataBase64已经是base64字符串，不需要前缀）
    const dataUrl = `data:${mimeType};base64,${audioDataBase64}`;
    
    console.log('准备下载文件:', finalFilename);
    
    // 下载文件
    downloadFile(dataUrl, finalFilename, successMessage);
    
  } catch (error) {
    console.error('保存音频失败:', error);
    if (chrome.notifications) {
      chrome.notifications.create({
        type: 'basic',
        title: '保存失败',
        message: '保存音频文件时发生错误: ' + (error.message || String(error))
      }).catch(err => {
        console.error('创建通知失败:', err);
      });
    }
  }
}

// 下载文件
function downloadFile(dataUrl, filename, successMessage) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('下载失败:', chrome.runtime.lastError);
        fallbackDownload(dataUrl, filename).then(resolve).catch(reject);
      } else {
        console.log('文件下载已启动，ID:', downloadId);
        
        // 显示通知
        if (chrome.notifications) {
          chrome.notifications.create({
            type: 'basic',
            title: '音频录制完成',
            message: successMessage || `文件已保存: ${filename}`
          }).catch(err => {
            console.error('创建通知失败:', err);
          });
        }
        
        resolve();
      }
    });
  });
}

// 备用下载方法（如果downloads API不可用）
function fallbackDownload(url, filename) {
  return new Promise((resolve, reject) => {
    // 在content script中执行下载
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: triggerDownloadInPage,
          args: [url, filename]
        }).then(() => {
          resolve();
        }).catch(err => {
          console.error('备用下载方法也失败:', err);
          // 如果备用方法也失败，至少显示通知
          if (chrome.notifications) {
            chrome.notifications.create({
              type: 'basic',
              title: '下载失败',
              message: '无法下载文件，请检查浏览器下载设置。文件名: ' + filename
            }).catch(notifErr => {
              console.error('创建通知失败:', notifErr);
            });
          }
          reject(err);
        });
      } else {
        reject(new Error('无法获取当前标签页'));
      }
    });
  });
}

// 在页面中执行的下载函数（这个函数会在content script的上下文中执行）
function triggerDownloadInPage(url, filename) {
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (error) {
    console.error('页面下载失败:', error);
  }
}

// 安装时的初始化
chrome.runtime.onInstalled.addListener(() => {
  console.log('音频录制器已安装');
});
