import type { PluginManifest } from '@mo-gallery/desktop-plugin-sdk'

export const manifest: PluginManifest = {
  id: 'webdav',
  version: '0.1.0',
  coreApiVersion: '1',
  apiVersion: '1',
  type: 'node',
  runtime: 'node22',
  name: 'WebDAV (飞牛云 / 通用)',
  description: 'Upload photos to any WebDAV server: fnOS (飞牛云), Nextcloud, 坚果云, Synology, Alist and more.',
  entry: 'dist/main.js',
  platforms: ['windows-amd64', 'darwin-amd64', 'darwin-arm64', 'linux-amd64', 'linux-arm64'],
  capabilities: ['plugin.health', 'source.validate', 'object.put', 'object.get', 'object.stat', 'object.list', 'object.move', 'object.delete', 'object.getUrl', 'checksum', 'idempotency'],
  contributions: [{
    domain: 'storage',
    apiVersion: '1',
    capabilities: ['plugin.health', 'source.validate', 'object.put', 'object.get', 'object.stat', 'object.list', 'object.move', 'object.delete', 'object.getUrl', 'checksum', 'idempotency'],
  }],
  permissions: ['network:configured-endpoint'],
  configSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string', title: 'WebDAV URL', description: 'WebDAV root URL, e.g. http://192.168.1.10:5666/dav for fnOS.',
        'x-i18n': {
          zh: { title: 'WebDAV 地址', description: 'WebDAV 根地址。飞牛云（fnOS）通常为 http://<IP>:5666/dav；坚果云为 https://dav.jianguoyun.com/dav/；Nextcloud 为 https://<域名>/remote.php/dav/files/<用户名>。' },
          en: { title: 'WebDAV URL', description: 'WebDAV root URL, e.g. http://192.168.1.10:5666/dav for fnOS or https://dav.jianguoyun.com/dav/ for 坚果云.' },
        },
      },
      basePath: {
        type: 'string', title: 'Base path', description: 'Optional subdirectory under the WebDAV root for all uploaded objects.',
        'x-i18n': { zh: { title: '基础路径', description: '可选。所有照片对象都会写入该子目录，如 photos。' }, en: { title: 'Base path', description: 'Optional subdirectory under the WebDAV root for all uploaded objects.' } },
      },
      publicUrl: {
        type: 'string', title: 'Public URL prefix', description: 'Optional. Public HTTP URL prefix when the server exposes objects without auth (e.g. via reverse proxy); leave empty to use the WebDAV URL.',
        'x-i18n': { zh: { title: '公开访问地址', description: '可选。服务器通过反向代理等公开暴露对象时填写公开 URL 前缀；留空则使用 WebDAV 地址。' }, en: { title: 'Public URL prefix', description: 'Optional public URL prefix when the server exposes objects without auth; leave empty to use the WebDAV URL.' } },
      },
    },
    required: ['url'],
  },
  credentialSchema: {
    type: 'object',
    properties: {
      password: { type: 'string', title: 'Password', format: 'password', 'x-i18n': { zh: { title: '密码' }, en: { title: 'Password' } } },
      username: { type: 'string', title: 'Username', 'x-i18n': { zh: { title: '用户名' }, en: { title: 'Username' } } },
    },
    required: ['username', 'password'],
  },
}
