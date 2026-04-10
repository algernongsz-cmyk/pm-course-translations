/**
 * 将 .md 文件转换为 .html 文件
 */

const fs = require('fs');
const path = require('path');

function markdownToHtml(markdown, title) {
  // 基本的markdown转HTML
  let html = markdown
    // 标题
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // 粗体和斜体
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // 链接
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // 代码块
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>')
    // 行内代码
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // 引用
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    // 段落（非空行且不是HTML标签）
    .split('\n\n')
    .map(block => {
      if (block.trim().startsWith('<')) return block;
      if (block.trim() === '') return '';
      return `<p>${block.replace(/\n/g, '<br>\n')}</p>`;
    })
    .join('\n\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      line-height: 1.8;
      color: #333;
    }
    h1, h2, h3 { margin-top: 1.5em; }
    code {
      background: #f5f5f5;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.9em;
    }
    pre {
      background: #f5f5f5;
      padding: 15px;
      border-radius: 8px;
      overflow-x: auto;
    }
    pre code { background: none; padding: 0; }
    blockquote {
      border-left: 4px solid #ddd;
      margin: 1em 0;
      padding-left: 1em;
      color: #666;
    }
    img { max-width: 100%; height: auto; }
    a { color: #0366d6; }
  </style>
</head>
<body>

<article>
${html}
</article>

</body>
</html>`;
}

function convertDirectory(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  
  for (const file of files) {
    const mdPath = path.join(dir, file);
    const htmlPath = mdPath.replace('.md', '.html');
    
    const markdown = fs.readFileSync(mdPath, 'utf-8');
    
    // 提取标题
    const titleMatch = markdown.match(/^# (.+)$/m);
    const title = titleMatch ? titleMatch[1] : file;
    
    const html = markdownToHtml(markdown, title);
    
    fs.writeFileSync(htmlPath, html);
    console.log(`✅ 转换: ${file} -> ${path.basename(htmlPath)}`);
    
    // 删除md文件
    fs.unlinkSync(mdPath);
    console.log(`🗑️ 删除: ${file}`);
  }
  
  console.log(`\n📊 共转换 ${files.length} 个文件`);
}

// 转换指定目录的文件
const dir = process.argv[2] || `/root/pm-course-translations/${new Date().toISOString().split('T')[0]}`;

if (fs.existsSync(dir)) {
  convertDirectory(dir);
} else {
  console.log(`目录不存在: ${dir}`);
}