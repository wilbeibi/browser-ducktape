// ==UserScript==
// @name         哔哩哔哩效率强制提醒助手
// @namespace    https://violentmonkey.github.io/
// @version      0.6
// @description  累计哔哩哔哩观看时间，总计达到30分钟后强制提醒，1小时内阻止继续观看
// @author       You
// @match        *://*.bilibili.com/video/*
// @match        *://*.bilibili.com/bangumi/*
// @match        *://*.bilibili.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function() {
    'use strict';

    // 配置参数
    const CONFIG = {
        TIME_LIMIT: 30 * 60 * 1000,      // 观看时间限制（毫秒）
        EXTENSION_TIME: 5 * 60 * 1000,   // 延长时间（毫秒）
        CHECK_INTERVAL: 5000,            // 检查间隔（毫秒）
        TIMER_DISPLAY_INTERVAL: 10000,   // 计时器显示更新间隔（毫秒）
        SESSION_TIMEOUT: 2 * 60 * 60 * 1000, // 会话超时时间 - 2小时没访问B站则重置计时器
        STORAGE_KEY: 'bilibili_watch_data', // 存储键名
        DEBUG: true                       // 调试模式
    };

    // 存储结构
    const defaultData = {
        totalWatchTime: 0,       // 总观看时间（毫秒）
        lastTimestamp: 0,        // 上次保存的时间戳
        timeExpires: 0,          // 时间限制到期时间戳
        extensionCount: 0        // 已延长次数
    };

    // 运行时变量
    let watchData = Object.assign({}, defaultData);
    let startTime = null;
    let timerDisplay = null;
    let timerInterval = null;
    let saveInterval = null;
    let checkInterval = null;
    let isLimitReached = false;

    // 调试日志功能
    function log(...args) {
        if (CONFIG.DEBUG) {
            console.log('[B站效率助手]', ...args);
        }
    }

    // 添加样式
    GM_addStyle(`
        #productivity-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.9);
            z-index: 999999;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            color: white;
            font-family: "Microsoft YaHei", Arial, sans-serif;
            opacity: 0;
            transition: opacity 0.5s ease;
        }

        #productivity-overlay.visible {
            opacity: 1;
        }

        #productivity-overlay h1 {
            margin-bottom: 10px;
            font-size: 28px;
            text-align: center;
        }

        #productivity-overlay h2 {
            margin-bottom: 30px;
            font-size: 20px;
            color: #FF9999;
            text-align: center;
        }

        #productivity-overlay p {
            margin-bottom: 20px;
            font-size: 16px;
            text-align: center;
            max-width: 80%;
        }

        #productivity-overlay button {
            padding: 10px 20px;
            font-size: 16px;
            cursor: pointer;
            border-radius: 4px;
            border: none;
            margin: 0 10px;
            transition: all 0.2s ease;
        }

        #productivity-overlay button:hover {
            transform: scale(1.05);
        }

        #productivity-overlay button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }

        #productivity-overlay #dismiss-button {
            background-color: #2196F3;
            color: white;
        }

        #productivity-overlay #exit-button {
            background-color: #FF6666;
            color: white;
        }

        #bilibili-timer {
            position: fixed;
            top: 10px;
            right: 10px;
            background-color: rgba(33, 33, 33, 0.7);
            color: white;
            padding: 5px 10px;
            border-radius: 4px;
            font-size: 14px;
            z-index: 9999;
            font-family: "Microsoft YaHei", Arial, sans-serif;
            display: flex;
            align-items: center;
        }

        #bilibili-timer-text {
            margin-right: 10px;
        }

        #bilibili-timer-reset {
            cursor: pointer;
            font-size: 12px;
            color: #ccc;
            background: none;
            border: none;
            padding: 2px;
        }

        #bilibili-timer-reset:hover {
            color: white;
        }

        #bilibili-timer.warning {
            background-color: rgba(255, 87, 34, 0.7);
        }

        #bilibili-timer.danger {
            background-color: rgba(244, 67, 54, 0.7);
            animation: pulse 1.5s infinite;
        }

        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.7; }
            100% { opacity: 1; }
        }
    `);

    // 检查是否为视频页面
    function isVideoPage() {
        return location.href.includes('/video/') || location.href.includes('/bangumi/');
    }

    // 加载保存的数据
    function loadWatchData() {
        const savedData = GM_getValue(CONFIG.STORAGE_KEY);
        if (savedData) {
            try {
                const parsedData = JSON.parse(savedData);

                // 检查会话是否过期
                const now = Date.now();
                const lastTime = parsedData.lastTimestamp || 0;

                if (now - lastTime > CONFIG.SESSION_TIMEOUT) {
                    // 如果超过会话超时时间，重置数据
                    log('会话超时，重置观看时间');
                    watchData = Object.assign({}, defaultData);
                } else {
                    // 否则使用保存的数据
                    watchData = parsedData;

                    // 检查是否已达到限制
                    if (watchData.timeExpires > now) {
                        log('时间限制仍然有效，到期时间：', new Date(watchData.timeExpires).toLocaleTimeString());
                        isLimitReached = true;
                    } else if (watchData.timeExpires > 0) {
                        log('时间限制已过期');
                        watchData.timeExpires = 0;
                        watchData.extensionCount = 0;
                        isLimitReached = false;
                    }
                }
            } catch (e) {
                console.error('解析保存的数据失败', e);
                watchData = Object.assign({}, defaultData);
            }
        } else {
            watchData = Object.assign({}, defaultData);
        }

        log('加载数据:', watchData);
    }

    // 保存数据
    function saveWatchData() {
        const now = Date.now();

        // 如果有当前会话时间，更新总观看时间
        if (startTime) {
            const currentSessionTime = now - startTime;
            watchData.totalWatchTime += currentSessionTime;
            startTime = now;
        }

        // 更新时间戳
        watchData.lastTimestamp = now;

        // 保存数据
        GM_setValue(CONFIG.STORAGE_KEY, JSON.stringify(watchData));
        log('保存数据:', watchData);
    }

    // 初始化函数
    function initialize() {
        log('初始化脚本...');

        // 加载保存的数据
        loadWatchData();

        // 检查是否需要显示限制
        const now = Date.now();
        if (isLimitReached && isVideoPage()) {
            // 如果已达到限制且在视频页面上，立即显示覆盖层
            log('在视频页面检测到时间限制，显示覆盖层');
            createTimeLimitOverlay();
        } else if (isLimitReached) {
            // 在非视频页面上禁用视频链接
            log('非视频页面检测到时间限制，禁用视频链接');
            disableVideoLinks();
        }

        // 在视频页面上设置计时器
        if (isVideoPage()) {
            log('在视频页面上设置计时器');

            // 创建计时器并显示
            createTimer();

            // 开始当前会话计时
            startTime = Date.now();

            // 设置定期保存和检查
            saveInterval = setInterval(saveWatchData, 30000);
            checkInterval = setInterval(checkWatchTime, CONFIG.CHECK_INTERVAL);
        }

        // 页面离开时保存数据
        window.addEventListener('beforeunload', saveWatchData);

        // 处理页面导航
        handlePageNavigation();

        log('哔哩哔哩效率强制提醒助手已启动');
    }

    // 创建计时器
    function createTimer() {
        if (timerDisplay) return;

        timerDisplay = document.createElement('div');
        timerDisplay.id = 'bilibili-timer';

        // 添加计时显示
        const timerText = document.createElement('span');
        timerText.id = 'bilibili-timer-text';
        timerDisplay.appendChild(timerText);

        // 添加重置按钮
        const resetButton = document.createElement('button');
        resetButton.id = 'bilibili-timer-reset';
        resetButton.textContent = '重置';
        resetButton.title = '重置计时器';
        resetButton.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm('确定要重置观看时间计时器吗？')) {
                resetWatchTime();
                updateTimerDisplay();
                log('用户手动重置了计时器');
            }
        });
        timerDisplay.appendChild(resetButton);

        document.body.appendChild(timerDisplay);

        // 开始更新计时器显示
        updateTimerDisplay();
        timerInterval = setInterval(updateTimerDisplay, CONFIG.TIMER_DISPLAY_INTERVAL);
    }

    // 更新计时器显示
    function updateTimerDisplay() {
        if (!timerDisplay) return;

        // 计算总观看时间
        const now = Date.now();
        const currentSessionTime = startTime ? now - startTime : 0;
        const totalTime = watchData.totalWatchTime + currentSessionTime;

        // 计算剩余时间（如果已接近限制）
        const remainingTime = CONFIG.TIME_LIMIT - totalTime;

        // 格式化时间显示
        let timeText;
        if (remainingTime <= 5 * 60 * 1000 && remainingTime > 0) {
            // 如果剩余不到5分钟，显示倒计时
            const remainingMinutes = Math.floor(remainingTime / 60000);
            const remainingSeconds = Math.floor((remainingTime % 60000) / 1000);
            timeText = `剩余: ${remainingMinutes}:${String(remainingSeconds).padStart(2, '0')}`;
            timerDisplay.className = 'danger';
        } else {
            // 否则显示总时间
            const hours = Math.floor(totalTime / 3600000);
            const minutes = Math.floor((totalTime % 3600000) / 60000);
            const seconds = Math.floor((totalTime % 60000) / 1000);

            timeText = hours > 0
                ? `总观看: ${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
                : `总观看: ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

            // 根据时间更新颜色
            if (totalTime > CONFIG.TIME_LIMIT * 0.8) {
                timerDisplay.className = 'warning';
            } else {
                timerDisplay.className = '';
            }
        }

        document.getElementById('bilibili-timer-text').textContent = timeText;
    }

    // 重置观看时间
    function resetWatchTime() {
        watchData = Object.assign({}, defaultData);
        watchData.lastTimestamp = Date.now();
        startTime = Date.now();
        isLimitReached = false;
        GM_setValue(CONFIG.STORAGE_KEY, JSON.stringify(watchData));

        // 移除现有覆盖层
        const existingOverlay = document.getElementById('productivity-overlay');
        if (existingOverlay) {
            document.body.removeChild(existingOverlay);
        }

        log('计时器已重置');
    }

    // 禁用视频链接
    function disableVideoLinks() {
        log('禁用视频链接...');
        document.querySelectorAll('a[href*="/video/"], a[href*="/bangumi/"]').forEach(link => {
            link.style.pointerEvents = 'none';
            link.style.opacity = '0.5';
            link.title = '观看时间已达到限制，请1小时后再试';

            // 添加点击事件阻止默认行为
            link.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                createTimeLimitOverlay();
                log('用户点击了已禁用的视频链接');
                return false;
            }, true);
        });
    }

    // 处理页面导航
    function handlePageNavigation() {
        // 监听页面导航事件
        const originalPushState = history.pushState;
        history.pushState = function() {
            const result = originalPushState.apply(this, arguments);
            onNavigate();
            return result;
        };

        const originalReplaceState = history.replaceState;
        history.replaceState = function() {
            const result = originalReplaceState.apply(this, arguments);
            onNavigate();
            return result;
        };

        window.addEventListener('popstate', onNavigate);

        // 拦截链接点击
        document.addEventListener('click', function(e) {
            if (isLimitReached) {
                const target = e.target.closest('a');
                if (target && (target.href.includes('/video/') || target.href.includes('/bangumi/'))) {
                    e.preventDefault();
                    e.stopPropagation();
                    createTimeLimitOverlay();
                    log('拦截了视频链接点击');
                    return false;
                }
            }
        }, true);

        log('页面导航处理已设置');
    }

    // 页面导航处理函数
    function onNavigate() {
        log('页面导航: ' + location.href);

        // 保存当前数据
        saveWatchData();

        // 检查是否需要阻止导航到视频
        if (isLimitReached && isVideoPage()) {
            log('检测到导航到视频页面，但已达到时间限制');
            createTimeLimitOverlay();
            return;
        }

        // 如果不再是视频页面，清理计时器
        if (!isVideoPage()) {
            clearTimers();

            if (isLimitReached) {
                // 在非视频页面上禁用视频链接
                setTimeout(disableVideoLinks, 1000);
            }
            return;
        }

        // 如果是新的视频页面，更新计时器
        if (!timerDisplay) {
            createTimer();
        }

        // 重置会话开始时间
        startTime = Date.now();

        // 重新开始检查
        if (!checkInterval) {
            checkInterval = setInterval(checkWatchTime, CONFIG.CHECK_INTERVAL);
        }

        // 确保保存间隔存在
        if (!saveInterval) {
            saveInterval = setInterval(saveWatchData, 30000);
        }

        // 更新显示
        updateTimerDisplay();
    }

    // 清理计时器
    function clearTimers() {
        log('清理计时器');

        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }

        if (timerDisplay && timerDisplay.parentNode) {
            timerDisplay.parentNode.removeChild(timerDisplay);
            timerDisplay = null;
        }
    }

    // 检查观看时间
    function checkWatchTime() {
        if (!isVideoPage() || isLimitReached) return;

        // 计算总观看时间
        const now = Date.now();
        const currentSessionTime = startTime ? now - startTime : 0;
        const totalTime = watchData.totalWatchTime + currentSessionTime;

        // 检查限制是否已过期
        if (watchData.timeExpires > 0 && now > watchData.timeExpires) {
            // 限制已过期，重置状态
            isLimitReached = false;
            watchData.extensionCount = 0; // 重置延长次数
            watchData.timeExpires = 0;
            log('时间限制已过期，重置状态');
        }

        // 检查是否达到限制
        if (totalTime >= CONFIG.TIME_LIMIT && !isLimitReached) {
            log('达到观看时间限制：' + Math.floor(totalTime / 60000) + '分钟');

            // 更新状态
            isLimitReached = true;

            // 保存当前会话时间
            saveWatchData();

            // 设置限制到期时间（1小时后）
            watchData.timeExpires = now + (60 * 60 * 1000); // 1小时后

            // 保存数据
            GM_setValue(CONFIG.STORAGE_KEY, JSON.stringify(watchData));

            // 显示覆盖层
            createTimeLimitOverlay();
        }
    }

    // 创建时间限制覆盖层
    function createTimeLimitOverlay() {
        log('创建时间限制覆盖层');

        // 如果已经存在覆盖层，先移除
        const existingOverlay = document.getElementById('productivity-overlay');
        if (existingOverlay) {
            document.body.removeChild(existingOverlay);
        }

        // 创建覆盖层
        const overlay = document.createElement('div');
        overlay.id = 'productivity-overlay';

        // 获取总时间的分钟表示
        const totalMinutes = Math.ceil(watchData.totalWatchTime / 60000);

        // 创建提示信息
        const message = document.createElement('div');
        message.innerHTML = `<h1>观看时间已达到限制！</h1><h2>你已经看了${totalMinutes}分钟哔哩哔哩了</h2>`;

        // 添加说明文字
        const description = document.createElement('p');
        description.textContent = `为了提高效率，建议你去做一些其他有意义的事情。你可以选择延长5分钟（已延长${watchData.extensionCount}次），或者暂时退出视频页面。1小时后限制将自动解除。`;

        // 创建继续按钮
        const dismissButton = document.createElement('button');
        dismissButton.id = 'dismiss-button';
        dismissButton.textContent = `再看 5 分钟 (${3 - watchData.extensionCount}次)`;

        // 如果已延长3次，禁用按钮
        if (watchData.extensionCount >= 3) {
            dismissButton.disabled = true;
            dismissButton.title = '延长次数已用完';
        }

        // 创建退出按钮
        const exitButton = document.createElement('button');
        exitButton.id = 'exit-button';
        exitButton.textContent = '退出视频';

        // 创建按钮容器
        const buttonContainer = document.createElement('div');
        buttonContainer.appendChild(dismissButton);
        buttonContainer.appendChild(exitButton);

        // 继续观看的功能
        dismissButton.addEventListener('click', function() {
            log('用户点击了"再看5分钟"按钮');

            if (watchData.extensionCount < 3) {
                // 更新延长次数
                watchData.extensionCount++;

                // 临时解除限制
                isLimitReached = false;

                // 减少已累计的时间
                watchData.totalWatchTime = Math.max(0, watchData.totalWatchTime - CONFIG.EXTENSION_TIME);

                // 设置新的会话开始时间
                startTime = Date.now();

                // 保存数据
                GM_setValue(CONFIG.STORAGE_KEY, JSON.stringify(watchData));

                // 移除覆盖层
                document.body.removeChild(overlay);

                // 更新计时器显示
                updateTimerDisplay();

                // 5分钟后重新检查
                setTimeout(function() {
                    checkWatchTime();
                }, CONFIG.EXTENSION_TIME);

                log('延长了5分钟，新的总时间：' + (watchData.totalWatchTime / 60000).toFixed(1) + '分钟');
            }
        });

        // 退出视频的功能
        exitButton.addEventListener('click', function() {
            log('用户点击了"退出视频"按钮');
            try {
                // 将用户重定向到B站首页
                window.location.href = 'https://www.bilibili.com/';
                log('重定向到首页');
            } catch (e) {
                console.error('重定向失败:', e);
                alert('退出失败，请手动返回首页');
            }
        });

        // 添加元素到覆盖层
        overlay.appendChild(message);
        overlay.appendChild(description);
        overlay.appendChild(buttonContainer);

        // 添加覆盖层到页面
        document.body.appendChild(overlay);

        // 触发动画
        setTimeout(() => {
            overlay.classList.add('visible');
        }, 10);

        log('覆盖层已创建并显示');
    }

    // 检查页面可见性变化（用于处理标签页切换）
    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'visible') {
            // 页面变为可见时，检查限制状态
            const now = Date.now();
            if (watchData.timeExpires > 0 && now > watchData.timeExpires) {
                // 限制已过期，重置状态
                isLimitReached = false;
                watchData.extensionCount = 0;
                watchData.timeExpires = 0;
                log('页面恢复可见，检测到时间限制已过期，重置状态');

                // 保存数据
                GM_setValue(CONFIG.STORAGE_KEY, JSON.stringify(watchData));

                // 如果有覆盖层，移除它
                const existingOverlay = document.getElementById('productivity-overlay');
                if (existingOverlay) {
                    document.body.removeChild(existingOverlay);
                }
            } else if (isLimitReached && isVideoPage()) {
                // 如果限制仍有效，并且在视频页面，显示覆盖层
                createTimeLimitOverlay();
            }
        }
    });

    // 延迟启动脚本
    setTimeout(initialize, 2000);
})();
