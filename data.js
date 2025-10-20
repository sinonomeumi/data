// ===================================================================================
//                                  多账户配置
// ===================================================================================
// 环境变量优先，没有则使用代码里填写的默认配置
// 这是一个多账号配置的示例，你可以在 ACCOUNTS 数组中添加更多账户
const DEFAULT_CONFIG = {
  ACCOUNTS: [
    {
      name: ' 账号1', // (必填) 账户别名，用于前端显示
      DATABRICKS_HOST: 'https://abc-1223456789.cloud.databricks.com',    // (必填) 账户1的工作区host
      DATABRICKS_TOKEN: 'dapi6dae4632d66931ecdeefe8808f12678dse',        // (必填) 账户1的token
      CHAT_ID: '',                                                       // (可选) 账户1的Telegram聊天ID
      BOT_TOKEN: ''                                                      // (可选) 账户1的Telegram机器人Token
    },
    {
      name: '账号2',
      DATABRICKS_HOST: 'https://xyz-9876543210.cloud.databricks.com',
      DATABRICKS_TOKEN: 'dapixxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      CHAT_ID: '',
      BOT_TOKEN: ''
     }
  ]
};

// ===================================================================================
//                              核心功能函数 (后端)
// ===================================================================================

/**
 * 获取所有账户的配置
 * 优先从 Cloudflare 环境变量中读取，格式为：
 * DATABRICKS_HOST_1, DATABRICKS_TOKEN_1 (对应第一个账户)
 * DATABRICKS_HOST_2, DATABRICKS_TOKEN_2 (对应第二个账户)
 * ...
 * 如果环境变量不存在，则使用上面 DEFAULT_CONFIG 中的配置
 */
function getConfigs(env) {
  const configs = [];
  const defaultAccounts = DEFAULT_CONFIG.ACCOUNTS || [];

  let i = 1;
  while (true) {
    const hostFromEnv = env[`DATABRICKS_HOST_${i}`];
    const tokenFromEnv = env[`DATABRICKS_TOKEN_${i}`];
    const defaultAccount = defaultAccounts[i - 1];

    if (!hostFromEnv && !defaultAccount) {
      break; // 当环境变量和默认配置都没有时，停止查找
    }

    const host = hostFromEnv || defaultAccount?.DATABRICKS_HOST;
    const token = tokenFromEnv || defaultAccount?.DATABRICKS_TOKEN;

    if (host && token) {
      // 优先使用账户专属的TG配置，再使用全局的
      const chatId = env[`CHAT_ID_${i}`] || defaultAccount?.CHAT_ID || env.CHAT_ID || '';
      const botToken = env[`BOT_TOKEN_${i}`] || defaultAccount?.BOT_TOKEN || env.BOT_TOKEN || '';
      
      configs.push({
        name: env[`ACCOUNT_NAME_${i}`] || defaultAccount?.name || `账户${i}`,
        DATABRICKS_HOST: host,
        DATABRICKS_TOKEN: token,
        CHAT_ID: chatId,
        BOT_TOKEN: botToken,
        source: {
          host: hostFromEnv ? `环境变量 (HOST_${i})` : '默认值',
          token: tokenFromEnv ? `环境变量 (TOKEN_${i})` : '默认值'
        }
      });
    }
    i++;
  }
  return configs;
}

/**
 * 发送 Telegram 通知
 */
async function sendTelegramNotification(config, message) {
  const { CHAT_ID, BOT_TOKEN, name } = config;
  if (!CHAT_ID || !BOT_TOKEN) {
    console.log(`账户 [${name}] 未配置 Telegram 通知，跳过发送`);
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: `<b>[${name}]</b>\n\n${message}`, // 在消息前加上账户名
        parse_mode: 'HTML'
      }),
    });
    const result = await response.json();
    if (result.ok) {
      console.log(`账户 [${name}] Telegram 通知发送成功`);
      return true;
    } else {
      console.error(`账户 [${name}] Telegram 通知发送失败:`, result);
      return false;
    }
  } catch (error) {
    console.error(`账户 [${name}] 发送 Telegram 通知时出错:`, error);
    return false;
  }
}

// 通知模板
const notificationTemplates = {
  offline: (appName, appId) => `🔴 <b>Databricks App 离线</b>\n\n📱 App: <code>${appName}</code>\n🆔 ID: <code>${appId}</code>\n⏰ 时间: ${new Date().toLocaleString('zh-CN')}\n\n⚡ 系统正在尝试自动重启...`,
  startSuccess: (appName, appId) => `✅ <b>Databricks App 启动成功</b>\n\n📱 App: <code>${appName}</code>\n🆔 ID: <code>${appId}</code>\n⏰ 时间: ${new Date().toLocaleString('zh-CN')}\n\n🎉 App 正在启动中,稍后请检查节点。`,
  startFailed: (appName, appId, error) => `❌ <b>Databricks App 启动失败</b>\n\n📱 App: <code>${appName}</code>\n🆔 ID: <code>${appId}</code>\n⏰ 时间: ${new Date().toLocaleString('zh-CN')}\n💥 错误: <code>${error}</code>\n\n🔧 请检查 App 配置或手动操作。`,
  manualOperation: (operation, results) => {
    const successCount = results.filter(r => r.status === 'started').length;
    const failedCount = results.filter(r => r.status === 'start_failed' || r.status === 'error').length;
    return `📊 <b>Databricks Apps ${operation}</b>\n\n✅ 成功启动: ${successCount} 个\n❌ 启动失败: ${failedCount} 个\n⏰ 时间: ${new Date().toLocaleString('zh-CN')}`;
  },
  test: () => `🔔 <b>监控测试通知</b>\n\n✅ 这是一条测试消息。\n⏰ 时间: ${new Date().toLocaleString('zh-CN')}\n\n🎉 配置正确！`
};

/**
 * 获取单个账户的 Apps 列表
 */
async function getAppsList(config) {
  const { DATABRICKS_HOST, DATABRICKS_TOKEN, name } = config;
  let allApps = [];
  let pageToken = '';
  
  do {
    let url = `${DATABRICKS_HOST}/api/2.0/apps?page_size=100`;
    if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${DATABRICKS_TOKEN}`, 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`账户 [${name}] API 请求失败: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const apps = (data.apps || []).map(app => ({ ...app, account: name }));
    allApps = allApps.concat(apps);
    pageToken = data.next_page_token || '';
  } while (pageToken);

  return allApps;
}

/**
 * 获取所有账户的 Apps 状态
 */
async function getAppsStatus(configs) {
  let allAppsResults = [];
  for (const config of configs) {
    try {
      const apps = await getAppsList(config);
      apps.forEach(app => allAppsResults.push({
        account: app.account,
        name: app.name,
        id: app.id,
        state: app.compute_status?.state || 'UNKNOWN',
        url: app.url,
        createdAt: app.creation_timestamp,
      }));
    } catch (error) {
      console.error(error.message);
      allAppsResults.push({ account: config.name, error: error.message });
    }
  }

  const summary = {
    total: allAppsResults.filter(app => !app.error).length,
    active: allAppsResults.filter(app => app.state === 'ACTIVE').length,
    stopped: allAppsResults.filter(app => app.state === 'STOPPED').length,
    unknown: allAppsResults.filter(app => app.state === 'UNKNOWN').length,
  };
    
  return { summary, apps: allAppsResults };
}

/**
 * 检查并启动所有账户的 Apps
 */
async function checkAndStartApps(configs) {
  const allResults = [];
  for (const config of configs) {
    try {
      const apps = await getAppsList(config);
      for (const app of apps) {
        const result = await processApp(app, config);
        allResults.push(result);
      }
    } catch (error) {
      console.error(`处理账户 [${config.name}] 时出错: ${error.message}`);
      allResults.push({ account: config.name, status: 'error', error: error.message });
    }
  }
  return allResults;
}

/**
 * 启动所有账户的停止的 Apps
 */
async function startStoppedApps(configs) {
  const allResults = [];
  for (const config of configs) {
    try {
      const apps = await getAppsList(config);
      const stoppedApps = apps.filter(app => (app.compute_status?.state || 'UNKNOWN') === 'STOPPED');
      console.log(`账户 [${config.name}] 找到 ${stoppedApps.length} 个停止的 Apps`);
      
      const accountResults = [];
      for (const app of stoppedApps) {
        const result = await startSingleApp(app, config);
        allResults.push(result);
        accountResults.push(result);
      }

      if (stoppedApps.length > 0) {
        await sendTelegramNotification(config, notificationTemplates.manualOperation('手动启动', accountResults));
      }
    } catch (error) {
      console.error(`启动账户 [${config.name}] 的Apps时出错: ${error.message}`);
      allResults.push({ account: config.name, status: 'error', error: error.message });
    }
  }
  return allResults;
}

/**
 * 处理单个 App 的检查与启动逻辑
 */
async function processApp(app, config) {
  const { name: appName, id: appId } = app;
  const computeState = app.compute_status?.state || 'UNKNOWN';

  if (computeState === 'STOPPED') {
    console.log(`⚡ App [${appName}] 已停止，尝试启动 | 账户: ${config.name}`);
    await sendTelegramNotification(config, notificationTemplates.offline(appName, appId));
    return startSingleApp(app, config);
  } else {
    return { account: config.name, app: appName, appId, status: 'healthy', computeState };
  }
}

/**
 * 启动单个 App
 */
async function startSingleApp(app, config) {
  const { DATABRICKS_HOST, DATABRICKS_TOKEN, name: accountName } = config;
  const { name: appName, id: appId } = app;

  try {
    const startUrl = `${DATABRICKS_HOST}/api/2.0/apps/${encodeURIComponent(appName)}/start`;
    const response = await fetch(startUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${DATABRICKS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const responseText = await response.text();
    if (response.ok) {
      console.log(`✅ App ${appName} 启动成功 | 账户: ${accountName}`);
      await sendTelegramNotification(config, notificationTemplates.startSuccess(appName, appId));
      return { account: accountName, app: appName, appId, status: 'started', success: true };
    } else {
      let errorMessage = responseText;
      try { // **健壮性修复**：安全地解析JSON
        errorMessage = JSON.parse(responseText).message || responseText;
      } catch (e) { /* ignore if not json */ }
      
      console.error(`❌ App ${appName} 启动失败: ${errorMessage} | 账户: ${accountName}`);
      await sendTelegramNotification(config, notificationTemplates.startFailed(appName, appId, errorMessage));
      return { account: accountName, app: appName, appId, status: 'start_failed', error: errorMessage };
    }
  } catch (error) {
    console.error(`❌ App ${appName} 启动请求错误: ${error.message} | 账户: ${accountName}`);
    await sendTelegramNotification(config, notificationTemplates.startFailed(appName, appId, error.message));
    return { account: accountName, app: appName, appId, status: 'error', error: error.message };
  }
}


// ===================================================================================
//                                  前端界面 (HTML)
// ===================================================================================
function getFrontendHTML(configs) {
  const accountOptions = configs.map(conf => `<option value="${conf.name}">${conf.name}</option>`).join('');

  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Databricks Apps 监控面板</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f6f9; display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; padding: 20px; }
        .container { width: 100%; max-width: 1200px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); overflow: hidden; } /* CSS 语法错误修复 */
        .header { background: linear-gradient(135deg, #2c3e50, #34495e); color: white; padding: 30px; text-align: center; }
        .header h1 { font-size: 2.5em; margin-bottom: 10px; }
        .header p { opacity: 0.9; font-size: 1.1em; }
        .controls { padding: 25px; background: #f8f9fa; border-bottom: 1px solid #e9ecef; display: flex; gap: 15px; flex-wrap: wrap; align-items: center; }
        .btn { padding: 12px 24px; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; transition: all 0.3s ease; display: flex; align-items: center; gap: 8px; }
        .btn-primary { background: #007bff; color: white; }
        .btn-primary:hover { background: #0056b3; transform: translateY(-2px); }
        .btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none !important; }
        select { padding: 12px; border-radius: 8px; border: 1px solid #ced4da; font-size: 16px; background: white; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; padding: 25px; }
        .stat-card { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); text-align: center; border-left: 5px solid #007bff; }
        .stat-number { font-size: 2.5em; font-weight: bold; color: #2c3e50; }
        .stat-label { color: #6c757d; font-size: 0.9em; margin-top: 5px; }
        .apps-list { padding: 25px; }
        .apps-table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05); }
        .apps-table th, .apps-table td { padding: 15px; text-align: left; border-bottom: 1px solid #e9ecef; }
        .apps-table th { background: #f8f9fa; font-weight: 600; color: #2c3e50; }
        .apps-table tr:hover { background: #f1f3f5; }
        .state-badge { padding: 4px 12px; border-radius: 20px; font-size: 0.85em; font-weight: 600; display: inline-block; }
        .state-active { background: #d4edda; color: #155724; }
        .state-stopped { background: #f8d7da; color: #721c24; }
        .state-unknown { background: #fff3cd; color: #856404; }
        .loading, .empty { text-align: center; padding: 40px; color: #6c757d; }
        .message { padding: 15px; border-radius: 8px; margin: 0 25px 25px 25px; border: 1px solid transparent; }
        .message-error { background-color: #f8d7da; color: #721c24; border-color: #f5c6cb; }
        .message-success { background-color: #d4edda; color: #155724; border-color: #c3e6cb; }
        .notification-status { background: #e7f3ff; padding: 15px; border-radius: 8px; margin: 25px; border-left: 4px solid #007bff; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 Databricks Apps 监控面板</h1>
            <p>实时监控和管理你的多账户 Databricks Apps</p>
        </div>
        
        <div class="notification-status" id="notificationStatusContainer"><div class="loading">检查通知配置...</div></div>
        
        <div class="controls">
            <button class="btn btn-primary" onclick="app.refreshStatus()">🔄 刷新</button>
            <button class="btn" style="background: #28a745; color: white;" onclick="app.startStoppedApps()">⚡ 启动停止</button>
            <button class="btn" style="background: #17a2b8; color: white;" onclick="app.checkAndStart()">🔍 检查启动</button>
            <button class="btn" style="background: #6f42c1; color: white;" onclick="app.testNotification()">🔔 测试通知</button>
            <div style="margin-left: auto; display: flex; align-items: center; gap: 15px;">
                <select id="accountSelector" onchange="app.filterView()">
                    <option value="all">所有账户</option>
                    ${accountOptions}
                </select>
                <div id="loadingIndicator" style="display: none; font-weight: bold; color: #007bff;">加载中...</div>
            </div>
        </div>
        
        <div id="messageContainer"></div>
        <div class="stats" id="statsContainer"><div class="loading">加载统计数据...</div></div>
        <div class="apps-list">
            <h2 style="margin-bottom: 20px; color: #2c3e50;">Apps 列表</h2>
            <div id="appsContainer"><div class="loading">加载 Apps 列表...</div></div>
        </div>
    </div>

    <script>
        const app = {
            fullData: null,
            
            init() {
                this.refreshStatus();
                this.checkTelegramStatus();
                setInterval(() => this.refreshStatus(), 5 * 60 * 1000); // 5分钟自动刷新
            },
            
            async checkTelegramStatus() {
                try {
                    const response = await fetch('/config');
                    const configs = await response.json();
                    const container = document.getElementById('notificationStatusContainer');
                    let html = '<strong>📢 通知状态:</strong>';
                    if (!configs || configs.length === 0) {
                        html += '<div style="color: #dc3545;">❌ 未找到任何账户配置</div>';
                    } else {
                        configs.forEach(config => {
                            const status = (config.CHAT_ID !== '未设置' && config.BOT_TOKEN !== '未设置')
                                ? '<span style="color: #28a745;">✅ 已配置</span>'
                                : '<span style="color: #ffc107;">⚠️ 未配置</span>';
                            html += \`<div style="margin-top: 8px; font-size: 0.9em;"><strong>\${config.name}:</strong> \${status}</div>\`;
                        });
                    }
                    container.innerHTML = html;
                } catch (error) {
                    document.getElementById('notificationStatusContainer').innerHTML = '<span style="color: #dc3545;">❌ 检查失败</span>';
                }
            },
            
            async apiCall(endpoint, options = {}, successMessage) {
                this.setLoading(true);
                this.clearMessage();
                try {
                    const response = await fetch(endpoint, options);
                    const data = await response.json();
                    if (!response.ok || !data.success) {
                        throw new Error(data.error || '未知错误');
                    }
                    if (successMessage) this.showMessage(successMessage, 'success');
                    return data;
                } catch (error) {
                    this.showMessage('操作失败: ' + error.message, 'error');
                    return null;
                } finally {
                    this.setLoading(false);
                }
            },

            async refreshStatus() {
                const data = await this.apiCall('/status');
                if (data) {
                    this.fullData = data.results;
                    this.filterView();
                }
            },
            
            async startStoppedApps() {
                if (!confirm('确定要启动所有账户中已停止的 Apps 吗？')) return;
                const data = await this.apiCall('/start', { method: 'POST' }, '启动命令已发送');
                if (data) setTimeout(() => this.refreshStatus(), 2000);
            },
            
            async checkAndStart() {
                const data = await this.apiCall('/check', { method: 'GET' }, '检查并启动命令已发送');
                if (data) setTimeout(() => this.refreshStatus(), 2000);
            },
            
            async testNotification() {
                await this.apiCall('/test-notification', { method: 'POST' }, '测试通知已发送，请检查 Telegram');
            },

            filterView() {
                if (!this.fullData) return;
                const selectedAccount = document.getElementById('accountSelector').value;
                const filteredApps = (selectedAccount === 'all')
                    ? this.fullData.apps
                    : this.fullData.apps.filter(app => app.account === selectedAccount);
                
                this.updateStats(filteredApps);
                this.updateAppsList(filteredApps);
            },

            updateStats(apps) {
                const container = document.getElementById('statsContainer');
                const summary = {
                    total: apps.filter(app => !app.error).length,
                    active: apps.filter(app => app.state === 'ACTIVE').length,
                    stopped: apps.filter(app => app.state === 'STOPPED').length,
                    unknown: apps.filter(app => app.state === 'UNKNOWN').length,
                };
                container.innerHTML = \`
                    <div class="stat-card"><div class="stat-number">\${summary.total}</div><div class="stat-label">总数</div></div>
                    <div class="stat-card" style="border-color: #28a745;"><div class="stat-number" style="color: #28a745;">\${summary.active}</div><div class="stat-label">运行中</div></div>
                    <div class="stat-card" style="border-color: #dc3545;"><div class="stat-number" style="color: #dc3545;">\${summary.stopped}</div><div class="stat-label">已停止</div></div>
                    <div class="stat-card" style="border-color: #ffc107;"><div class="stat-number" style="color: #ffc107;">\${summary.unknown}</div><div class="stat-label">未知</div></div>
                \`;
            },
            
            updateAppsList(apps) {
                const container = document.getElementById('appsContainer');
                if (!apps || apps.length === 0) {
                    container.innerHTML = '<div class="empty">没有找到任何 Apps</div>';
                    return;
                }
                
                const tableRows = apps.map(app => {
                    if (app.error) {
                        return \`<tr><td><strong>\${app.account}</strong></td><td colspan="4" style="color:#dc3545;">获取失败: \${app.error}</td></tr>\`;
                    }
                    const stateClass = \`state-\${(app.state || 'unknown').toLowerCase()}\`;
                    const createDate = app.createdAt ? new Date(app.createdAt).toLocaleString() : '未知';
                    return \`<tr>
                        <td><strong>\${app.account}</strong></td>
                        <td>\${app.name}</td>
                        <td><span class="state-badge \${stateClass}">\${app.state}</span></td>
                        <td><code>\${app.id}</code></td>
                        <td>\${createDate}</td>
                    </tr>\`;
                }).join('');
                
                container.innerHTML = \`
                    <table class="apps-table">
                        <thead><tr><th>账户</th><th>App 名称</th><th>状态</th><th>App ID</th><th>创建时间</th></tr></thead>
                        <tbody>\${tableRows}</tbody>
                    </table>\`;
            },
            
            showMessage(message, type = 'success') {
                const container = document.getElementById('messageContainer');
                container.innerHTML = \`<div class="message message-\${type}">\${message}</div>\`;
            },
            
            clearMessage() {
                document.getElementById('messageContainer').innerHTML = '';
            },

            setLoading(loading) {
                document.getElementById('loadingIndicator').style.display = loading ? 'block' : 'none';
                document.querySelectorAll('.btn, select').forEach(el => el.disabled = loading);
            }
        };
        
        document.addEventListener('DOMContentLoaded', () => app.init());
    </script>
</body>
</html>
  `;
}

// ===================================================================================
//                                Worker 入口点
// ===================================================================================
export default {
  /**
   * 处理 HTTP 请求
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const configs = getConfigs(env);

    if (path === '/' || path === '/index.html') {
      return new Response(getFrontendHTML(configs), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    try {
      if (path === '/status' && request.method === 'GET') {
        const result = await getAppsStatus(configs);
        return Response.json({ success: true, results: result });
      }
      if (path === '/check' && request.method === 'GET') {
        const result = await checkAndStartApps(configs);
        return Response.json({ success: true, results: result });
      }
      if (path === '/start' && request.method === 'POST') {
        const result = await startStoppedApps(configs);
        return Response.json({ success: true, results: result });
      }
      if (path === '/config' && request.method === 'GET') {
        const result = configs.map(c => ({
          name: c.name,
          DATABRICKS_HOST: c.DATABRICKS_HOST,
          DATABRICKS_TOKEN: c.DATABRICKS_TOKEN ? 'dapi...' + c.DATABRICKS_TOKEN.slice(-4) : '未设置',
          CHAT_ID: c.CHAT_ID || '未设置',
          BOT_TOKEN: c.BOT_TOKEN ? '...' + c.BOT_TOKEN.slice(-4) : '未设置'
        }));
        return Response.json(result);
      }
      if (path === '/test-notification' && request.method === 'POST') {
        let allSuccess = true;
        for (const config of configs) {
          if (!(await sendTelegramNotification(config, notificationTemplates.test()))) {
            allSuccess = false;
          }
        }
        if (!allSuccess) throw new Error('部分或全部通知发送失败，请检查配置和网络');
        return Response.json({ success: true });
      }
      
      return new Response(JSON.stringify({ error: '路由不存在' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      
    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  },
  
  /**
   * 处理定时任务
   */
  async scheduled(event, env, ctx) {
    console.log('开始定时检查所有账户的 Databricks Apps 状态...');
    try {
      const configs = getConfigs(env);
      if (configs.length > 0) {
        await checkAndStartApps(configs);
        console.log('所有账户定时检查完成');
      } else {
        console.warn('未找到任何账户配置，跳过定时任务');
      }
    } catch (error) {
      console.error('定时检查过程中出错:', error);
    }
  }
};