import type { PluginManifest } from '@mo-gallery/desktop-plugin-sdk'

export const manifest: PluginManifest = {
  id: 'github',
  version: '0.1.0',
  coreApiVersion: '1',
  apiVersion: '1',
  type: 'node',
  runtime: 'node22',
  name: 'GitHub 仓库',
  description: 'Upload photos to a GitHub repository (Contents API). Supports GitHub.com and GitHub Enterprise.',
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
      owner: {
        type: 'string', title: 'Owner', description: 'GitHub username or organization name.',
        'x-i18n': {
          zh: { title: '仓库所有者', description: 'GitHub 用户名或组织名，例如 ushaio。' },
          en: { title: 'Owner', description: 'GitHub username or organization name, e.g. ushaio.' },
        },
      },
      repo: {
        type: 'string', title: 'Repository', description: 'Repository name.',
        'x-i18n': {
          zh: { title: '仓库名称', description: '要上传照片的仓库名称。' },
          en: { title: 'Repository', description: 'The repository that photos are uploaded to.' },
        },
      },
      branch: {
        type: 'string', title: 'Branch', description: 'Leave empty to use the repository default branch (e.g. main).',
        'x-i18n': {
          zh: { title: '分支', description: '可选。留空使用仓库默认分支（如 main）。' },
          en: { title: 'Branch', description: 'Leave empty to use the repository default branch (e.g. main).' },
        },
      },
      basePath: {
        type: 'string', title: 'Base path', description: 'Optional directory prefix for all uploaded objects, e.g. photos.',
        'x-i18n': { zh: { title: '基础路径', description: '可选。所有照片对象都会写入该目录前缀，如 photos。' }, en: { title: 'Base path', description: 'Optional directory prefix for all uploaded objects, e.g. photos.' } },
      },
      apiUrl: {
        type: 'string', title: 'API URL', description: 'Leave empty for GitHub.com; GitHub Enterprise uses https://<host>/api/v3.',
        'x-i18n': {
          zh: { title: 'API 地址', description: '可选。GitHub.com 留空即可；GitHub Enterprise Server 填写 https://<域名>/api/v3。' },
          en: { title: 'API URL', description: 'Leave empty for GitHub.com; GitHub Enterprise Server uses https://<host>/api/v3.' },
        },
      },
      rawUrl: {
        type: 'string', title: 'Raw URL prefix', description: 'Optional raw file URL prefix; leave empty to use https://raw.githubusercontent.com/{owner}/{repo}.',
        'x-i18n': {
          zh: { title: '原始文件地址前缀', description: '可选。对象访问地址的前缀；留空使用 https://raw.githubusercontent.com/{owner}/{repo}。私有仓库返回的地址需要令牌才能访问。' },
          en: { title: 'Raw URL prefix', description: 'Optional raw file URL prefix; leave empty to use https://raw.githubusercontent.com/{owner}/{repo}. Private repository URLs still require a token.' },
        },
      },
    },
    required: ['owner', 'repo'],
  },
  credentialSchema: {
    type: 'object',
    properties: {
      token: { type: 'string', title: 'Access token', format: 'password', 'x-i18n': { zh: { title: '访问令牌', description: '需要仓库读写权限的 Personal Access Token（classic 勾选 repo，或 fine-granted 授予 Contents 读写）。' }, en: { title: 'Access token', description: 'Personal Access Token with repository read/write access (classic repo scope, or fine-grained Contents read/write).' } } },
    },
    required: ['token'],
  },
}
