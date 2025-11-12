// Popup脚本
let currentStatus = {
  isRecording: false,
  hasVideo: false,
  hasBvid: false,
  bvid: null
};

// 获取当前标签页
async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// 更新状态显示
function updateStatus() {
  const statusDiv = document.getElementById('status');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  
  if (!currentStatus.hasBvid) {
    statusDiv.textContent = '未检测到BV号\n请在B站视频页面使用';
    statusDiv.className = 'status no-video';
    startBtn.disabled = true;
    stopBtn.disabled = true;
  } else if (!currentStatus.hasVideo) {
    statusDiv.textContent = `BV号: ${currentStatus.bvid}\n未检测到视频元素`;
    statusDiv.className = 'status no-video';
    startBtn.disabled = true;
    stopBtn.disabled = true;
  } else if (currentStatus.isRecording) {
    statusDiv.textContent = `BV号: ${currentStatus.bvid}\n● 正在捕获中...`;
    statusDiv.className = 'status recording';
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } else {
    statusDiv.textContent = `BV号: ${currentStatus.bvid}\n就绪 - 点击开始捕获`;
    statusDiv.className = 'status idle';
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

// 获取状态
async function refreshStatus() {
  try {
    const tab = await getCurrentTab();
    if (!tab) return;
    
    // 向content script发送消息获取状态
    chrome.tabs.sendMessage(tab.id, { type: 'getStatus' }, (response) => {
      if (chrome.runtime.lastError) {
        // content script可能未加载，这是正常的
        const errorMsg = chrome.runtime.lastError.message || String(chrome.runtime.lastError);
        console.log('获取状态失败（可能content script未加载）:', errorMsg);
        currentStatus.hasVideo = false;
        currentStatus.isRecording = false;
        currentStatus.hasBvid = false;
        currentStatus.bvid = null;
      } else if (response) {
        currentStatus.isRecording = response.isRecording;
        currentStatus.hasVideo = response.hasVideo;
        currentStatus.hasBvid = response.hasBvid || false;
        currentStatus.bvid = response.bvid || null;
      } else {
        // 没有响应，可能是content script未加载
        currentStatus.hasVideo = false;
        currentStatus.isRecording = false;
        currentStatus.hasBvid = false;
        currentStatus.bvid = null;
      }
      updateStatus();
    });
  } catch (error) {
    console.error('刷新状态失败:', error);
  }
}

// 开始捕获（跳转到第0秒并开始录制）
async function startCapture() {
  try {
    const tab = await getCurrentTab();
    if (!tab) return;
    
    // 确认对话框
    const confirmed = confirm('确定要开始捕获吗？\n\n将跳转到视频第0秒并开始录制音频和字幕。');
    if (!confirmed) {
      return;
    }
    
    chrome.tabs.sendMessage(tab.id, { type: 'startCapture' }, (response) => {
      if (chrome.runtime.lastError) {
        alert('启动捕获失败: ' + chrome.runtime.lastError.message);
      } else if (response && response.success) {
        currentStatus.isRecording = true;
        updateStatus();
      } else {
        alert('启动捕获失败，请确保在B站视频页面使用');
      }
    });
  } catch (error) {
    alert('启动捕获失败: ' + error.message);
  }
}

// 开始录制（兼容旧版本）
async function startRecording() {
  await startCapture();
}

// 停止录制
async function stopRecording() {
  try {
    const tab = await getCurrentTab();
    if (!tab) return;
    
    chrome.tabs.sendMessage(tab.id, { type: 'stopRecording' }, (response) => {
      if (chrome.runtime.lastError) {
        alert('停止录制失败: ' + chrome.runtime.lastError.message);
      } else {
        currentStatus.isRecording = false;
        updateStatus();
      }
    });
  } catch (error) {
    alert('停止录制失败: ' + error.message);
  }
}

// 监听来自background的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'recordingStarted') {
    currentStatus.isRecording = true;
    updateStatus();
  } else if (request.type === 'recordingStopped') {
    currentStatus.isRecording = false;
    updateStatus();
  }
});

// 绑定按钮事件
document.getElementById('startBtn').addEventListener('click', startCapture);
document.getElementById('stopBtn').addEventListener('click', stopRecording);

// 初始化
refreshStatus();
// 定期刷新状态
setInterval(refreshStatus, 1000);

