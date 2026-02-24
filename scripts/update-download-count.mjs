#!/usr/bin/env node
/**
 * 更新插件下载量
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PLUGINS_FILE = resolve(ROOT, 'plugins.v4.json');
const DOWNLOADS_FILE = resolve(ROOT, 'downloads.json');

const GITHUB_API_BASE = 'https://api.github.com';
const CONCURRENCY = 5;            // 并发请求数
const RETRY_TIMES = 2;             // 失败重试次数
const RETRY_DELAY = 1000;          // 重试延迟（毫秒）

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function logError(msg) {
  console.error(`[${new Date().toISOString()}] ❌ ${msg}`);
}

function logOk(msg) {
  console.log(`[${new Date().toISOString()}] ✅ ${msg}`);
}

// 从下载链接中提取 GitHub 仓库信息
function extractGitHubRepo(downloadUrl) {
  try {
    const url = new URL(downloadUrl);
    if (url.hostname !== 'github.com') return null;
    const parts = url.pathname.split('/').filter(p => p);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

// 带重试的 fetch 请求
async function fetchWithRetry(url, options = {}, retry = RETRY_TIMES) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      throw new Error(`GitHub API 返回 ${res.status} (${res.statusText})`);
    }
    return res.json();
  } catch (err) {
    if (retry > 0) {
      log(`请求失败，剩余重试次数: ${retry}，错误: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return fetchWithRetry(url, options, retry - 1);
    }
    throw err;
  }
}

// 获取仓库的所有 releases，计算 assets 下载总数
async function fetchGitHubReleases(owner, repo, token) {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/releases`;
  const headers = {
    'User-Agent': 'napcat-plugin-index',
    'Accept': 'application/vnd.github.v3+json'
  };
  if (token) headers['Authorization'] = `token ${token}`;
  return fetchWithRetry(url, { headers });
}

// 获取单个插件的下载量
async function getDownloadCountForPlugin(plugin, token) {
  const { id, downloadUrl } = plugin;
  const repoInfo = extractGitHubRepo(downloadUrl);

  if (!repoInfo) {
    return { id, count: null, error: '无法提取 GitHub 仓库信息' };
  }

  try {
    const releases = await fetchGitHubReleases(repoInfo.owner, repoInfo.repo, token);
    let total = 0;
    for (const release of releases) {
      if (release.assets) {
        for (const asset of release.assets) {
          total += asset.download_count || 0;
        }
      }
    }
    return { id, count: total, error: null };
  } catch (err) {
    return { id, count: null, error: err.message };
  }
}

// 主函数
async function main() {
  // 检查插件文件是否存在
  if (!existsSync(PLUGINS_FILE)) {
    throw new Error(`插件文件不存在: ${PLUGINS_FILE}`);
  }
  log(`读取插件列表: ${PLUGINS_FILE}`);

  // 读取并解析
  let plugins;
  try {
    const content = readFileSync(PLUGINS_FILE, 'utf-8');
    const data = JSON.parse(content);
    plugins = data.plugins || [];
  } catch (err) {
    throw new Error(`解析插件文件失败: ${err.message}`);
  }

  if (plugins.length === 0) {
    log('⚠️ 插件列表为空');
    return;
  }
  log(`共找到 ${plugins.length} 个插件，开始获取下载量...`);

  const token = process.env.GITHUB_TOKEN || null;

  // 并发获取下载量
  const results = [];
  for (let i = 0; i < plugins.length; i += CONCURRENCY) {
    const batch = plugins.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(p => getDownloadCountForPlugin(p, token))
    );
    results.push(...batchResults);
  }

  // 构建下载量映射
  const downloadsMap = {};
  for (const res of results) {
    if (res.error) {
      logError(`[${res.id}] 获取失败: ${res.error}，设为 0`);
      downloadsMap[res.id] = 0;
    } else {
      downloadsMap[res.id] = res.count;
      logOk(`[${res.id}] 下载量: ${res.count}`);
    }
  }

  // 写入 downloads.json
  try {
    writeFileSync(DOWNLOADS_FILE, JSON.stringify(downloadsMap, null, 2), 'utf-8');
    log(`✅ 精简下载量文件已写入: ${DOWNLOADS_FILE}`);
  } catch (err) {
    throw new Error(`写入文件失败: ${err.message}`);
  }
}

// 执行
main().catch(err => {
  logError(`脚本异常退出: ${err.message}`);
  process.exit(1);
});