/**
 * @file server/http-client/download-single.js - 单流下载
 * @description 支持续传、SHA1 校验、JAR 完整性校验、stall 超时检测。
 *   通过 ctx (../context) 访问共享状态，通过 utils (../utils) 访问工具函数，依赖 ./file-ops 的安全重命名/删除。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const ctx = require('../context');
const utils = require('../utils');
const { safeRename, _tryRemoveFile } = require('./file-ops');

/**
 * 单流下载：支持续传、SHA1 校验、JAR 完整性校验、stall 超时检测
 * @param {string} urlStr - 下载 URL
 * @param {string} destPath - 目标文件路径
 * @param {object} [options={}] - onProgress / sha1 / timeout / retries / abortSignal / stallTimeout / agent
 * @returns {Promise<{size: number, path: string}>}
 */
async function _dlSingle(urlStr, destPath, options = {}) {
  const { onProgress = null, sha1 = null, timeout = 60000, retries = 3, abortSignal = null, stallTimeout = 60000, agent: customAgent = null } = options;
  const isHttps = urlStr.startsWith('https');
  const agent = customAgent || (isHttps ? ctx.httpAgents.SHARED_HTTPS_AGENT : ctx.httpAgents.SHARED_HTTP_AGENT);
  
  while (!ctx.DownloadManager.acquireConnection()) {
    if (abortSignal && abortSignal.aborted) throw new Error('下载已中止');
    await new Promise((r) => setTimeout(r, 50));
  }
  
  const tmpPath = destPath + '.downloading';
  let settled = false;
  
  try {
    if (abortSignal && abortSignal.aborted) throw new Error('下载已中止');
    
    return await new Promise((resolve, reject) => {
      const doReject = (e) => { if (!settled) { settled = true; reject(e); } };
      const doResolve = (v) => { if (!settled) { settled = true; resolve(v); } };
      let currentAbortHandler = null;
      
      const removeAbortListener = () => {
        if (currentAbortHandler && abortSignal) {
          try { abortSignal.removeEventListener('abort', currentAbortHandler); } catch (_) {}
          currentAbortHandler = null;
        }
      };
      
      const attempt = (rc) => {
        if (settled) return;
        if (abortSignal && abortSignal.aborted) { doReject(new Error('下载已中止')); return; }
        removeAbortListener();
        
        const mod = urlStr.startsWith('https') ? https : http;
        utils.ensureDir(destPath);
        const reqHeaders = { 'User-Agent': 'Brix/2.0', 'Connection': 'keep-alive' };
        
        let resumeOffset = 0;
        try {
          if (fs.existsSync(tmpPath)) {
            const stat = fs.statSync(tmpPath);
            if (stat.size > 0) {
              resumeOffset = stat.size;
              console.debug(`[Download] 发现续传文件，从 ${resumeOffset} 字节开始: ${path.basename(destPath)}`);
            }
          }
        } catch (_) {}
        
        if (resumeOffset > 0) {
          reqHeaders['Range'] = `bytes=${resumeOffset}-`;
        }
        
        let ws = null;
        let cleaned = false;
        let stallTimer = null;
        let totalSize = 0;
        
        const clean = (keepTmp = false) => {
          if (cleaned) return;
          cleaned = true;
          try { if (ws) ws.destroy(); } catch (_) {}
          if (!keepTmp) _tryRemoveFile(tmpPath);
          _tryRemoveFile(destPath);
          if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        };
        
        const resetStall = () => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            if (!settled && !cleaned) {
              try { 
                if (onProgress) onProgress({ bytesDownloaded: resumeOffset, totalBytes: totalSize, speed: 0, progress: 0, chunks: 1, activeChunks: 1, stall: true }); 
              } catch (_) {}
              try { req.destroy(); } catch (_) {}
              clean(true);
              if (rc > 0) {
                console.warn(`[Download] Stall超时，${stallTimeout}ms内无数据，重试 ${rc} 次`);
                setTimeout(() => attempt(rc - 1), 2000 + Math.random() * 1000);
              } else {
                doReject(new Error(`Stall timeout: ${urlStr} (${stallTimeout}ms)`));
              }
            }
          }, stallTimeout);
        };
        
        currentAbortHandler = () => {
          try { req.destroy(); } catch (_) {}
          clean(false);
          doReject(new Error('下载已中止'));
        };
        
        if (abortSignal) {
          if (abortSignal.aborted) { currentAbortHandler(); return; }
          abortSignal.addEventListener('abort', currentAbortHandler, { once: true });
        }
        
        resetStall();
        
        const req = mod.get(urlStr, { headers: reqHeaders, agent, timeout }, (res) => {
          if (settled) { res.destroy(); return; }
          if (abortSignal && abortSignal.aborted) { res.destroy(); clean(false); doReject(new Error('下载已中止')); return; }
          
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            clean(false);
            const nu = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, urlStr).toString();
            console.debug(`[Download] 重定向到: ${nu.substring(0, 50)}`);
            return _dlSingle(nu, destPath, { onProgress, sha1, timeout, retries: rc, abortSignal, stallTimeout }).then(doResolve).catch(doReject);
          }
          
          const isResume = (res.statusCode === 206 && resumeOffset > 0);
          if (res.statusCode !== 200 && res.statusCode !== 206) {
            clean(false);
            doReject(new Error(`HTTP ${res.statusCode} for ${urlStr}`));
            return;
          }
          
          if (resumeOffset > 0 && !isResume) {
            console.warn(`[Download] 服务器不支持续传，从头下载: ${path.basename(destPath)}`);
            resumeOffset = 0;
          }
          
          const contentLen = parseInt(res.headers['content-length'] || '0', 10);
          totalSize = isResume ? (resumeOffset + contentLen) : contentLen;
          let dl = resumeOffset;
          
          ws = fs.createWriteStream(tmpPath, isResume ? { flags: 'a' } : {});
          
          res.on('data', (ch) => {
            if (settled) { res.destroy(); return; }
            dl += ch.length;
            ctx.DownloadManager.recordProgress(ch.length);
            resetStall();
            try { 
              if (onProgress) onProgress({ 
                bytesDownloaded: dl, 
                totalBytes: totalSize, 
                speed: ctx.DownloadManager.getSpeed(), 
                progress: totalSize > 0 ? (dl / totalSize * 100) : 0, 
                chunks: 1, 
                activeChunks: 1 
              }); 
            } catch (_) {}
          });
          
          res.pipe(ws);
          
          res.on('error', (e) => {
            try { ws.destroy(); } catch (_) {}
            clean(true);
            if (settled) return;
            if (rc > 0) { 
              console.warn(`[Download] 网络错误，重试 ${rc} 次: ${e.message}`);
              setTimeout(() => attempt(rc - 1), 2000 + Math.random() * 500); 
            }
            else { doReject(e); }
          });
          
          ws.on('finish', async () => {
            try {
              if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
              
              await new Promise((resolve) => {
                if (ws.destroyed) return resolve();
                const done = () => { ws.removeListener('close', done); resolve(); };
                ws.on('close', done);
                try { ws.close(); } catch (_) { done(); }
                setTimeout(done, 2000);
              });
              
              if (settled || cleaned) return;
              
              if (totalSize > 0 && dl !== totalSize) {
                console.warn(`[Download] 大小不匹配: ${path.basename(destPath)} expected=${totalSize} got=${dl}`);
                clean(true);
                if (rc > 0 && !settled) { setTimeout(() => attempt(rc - 1), 2000); }
                else { doReject(new Error(`Size mismatch: ${path.basename(destPath)} expected=${totalSize} got=${dl}`)); }
                return;
              }
              
              if (dl === 0) {
                clean(false);
                if (rc > 0 && !settled) { setTimeout(() => attempt(rc - 1), 1000); }
                else { doReject(new Error(`Empty file: ${path.basename(destPath)}`)); }
                return;
              }
              
              if (destPath.toLowerCase().endsWith('.jar') && !utils.isJarIntact(tmpPath)) {
                const fileSize = dl || (fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0);
                console.warn(`[Download] JAR文件ZIP结构不完整: ${path.basename(destPath)} (${fileSize} bytes)`);
                clean(false);
                if (rc > 0 && !settled) { setTimeout(() => attempt(rc - 1), 1000); }
                else { doReject(new Error(`JAR not intact: ${path.basename(destPath)} (${fileSize} bytes)`)); }
                return;
              }
              
              if (sha1) {
                const a = await utils.calculateSHA1(tmpPath);
                if (settled || cleaned) return;
                if (a !== sha1) {
                  console.warn(`[Download] SHA1不匹配: ${path.basename(destPath)}`);
                  clean(false);
                  if (rc > 0 && !settled) { setTimeout(() => attempt(rc - 1), 1000); }
                  else { doReject(new Error(`SHA1 mismatch: ${path.basename(destPath)}`)); }
                  return;
                }
              }
              
              if (settled || cleaned) return;
              
              const _renameOK = await safeRename(tmpPath, destPath);
              if (!_renameOK) {
                clean(true);
                console.error(`[Download] 无法写入文件: ${path.basename(destPath)}`);
                if (!settled) doReject(new Error(`无法写入文件 ${path.basename(destPath)}: 文件可能被占用`));
                return;
              }
              
              doResolve({ size: dl, path: destPath });
            } catch (e) {
              console.error(`[Download] finish处理异常: ${e.message}`);
              clean(true);
              if (!settled) doReject(e);
            }
          });
          
          ws.on('error', (e) => {
            clean(true);
            if (settled) return;
            if (rc > 0) { 
              console.warn(`[Download] 写入错误，重试 ${rc} 次: ${e.message}`);
              setTimeout(() => attempt(rc - 1), 2000 + Math.random() * 500); 
            }
            else { doReject(e); }
          });
        });
        
        req.on('error', (e) => {
          clean(true);
          if (settled) return;
          if (rc > 0) { 
            const waitTime = Math.min(2000 + (retries - rc) * 1500, 10000);
            console.warn(`[Download] 请求错误，${waitTime}ms后重试: ${e.message}`);
            setTimeout(() => attempt(rc - 1), waitTime); 
          }
          else { doReject(e); }
        });
        
        req.setTimeout(timeout, () => {
          req.destroy();
          clean(true);
          if (settled) return;
          if (rc > 0) { 
            console.warn(`[Download] 请求超时，重试 ${rc} 次`);
            setTimeout(() => attempt(rc - 1), 3000); 
          }
          else { doReject(new Error(`Timeout: ${urlStr} (${timeout}ms)`)); }
        });
      };
      
      attempt(retries);
    });
  } finally {
    ctx.DownloadManager.releaseConnection();
  }
}

module.exports = { _dlSingle };
