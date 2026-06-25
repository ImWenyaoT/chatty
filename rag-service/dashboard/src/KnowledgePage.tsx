import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import {
  addKnowledge,
  captionImage,
  deleteKnowledge,
  fetchKnowledge,
  fetchTemplates,
  uploadMedia,
  type KnowledgeTemplate,
} from './api';
import type {
  KnowledgeContentType,
  KnowledgeEntry,
  KnowledgeFormat,
  KnowledgeListResponse,
  KnowledgeSourceType,
} from './types';

const SOURCE_TYPE_LABEL: Record<KnowledgeSourceType, string> = {
  rule: '规则',
  history: '历史',
  product: '商品',
};

const SOURCE_TYPE_COLOR: Record<KnowledgeSourceType, string> = {
  rule: '#22d3ee',
  history: '#a78bfa',
  product: '#34d399',
};

const CONTENT_TYPE_LABEL: Record<KnowledgeContentType, string> = {
  qa: 'Q&A',
  text: '段落',
  image: '图片',
};

const FORMAT_OPTIONS: { key: KnowledgeFormat; label: string; hint: string }[] = [
  { key: 'product', label: '🛍 商品档案（一次录入介绍+多张图+属性+FAQ）', hint: '向导式表单。一次提交自动生成"概览 + 逐属性 Q&A + 每张图片一块 + 补充 FAQ"多条 chunk，全部归到同一商品 title 下。' },
  { key: 'qa', label: 'Q&A 问答', hint: '逐条录入问题-答案（最推荐 · 命中率最高）' },
  { key: 'image', label: '图片 + 说明', hint: '上传图片并写文字说明；检索命中后答案会带回图片链接' },
  { key: 'text', label: '纯文本', hint: '一整段文字，按 500 字左右自动切块' },
  { key: 'markdown', label: 'Markdown', hint: '支持标题、列表、段落，按固定长度切块' },
  { key: 'csv', label: 'CSV', hint: '首行必须是 question,answer' },
  { key: 'json', label: 'JSON', hint: '数组：[{"question":"...","answer":"..."}] 或任意结构' },
];

const CAPTION_PRESETS = [
  '正面全身效果图',
  '背面效果图',
  '侧面效果图',
  '细节特写',
  '面料特写',
  '领口特写',
  '袖口特写',
  '裤脚特写',
  '扣子/拉链特写',
  '腰带/配件',
  '吊牌与洗涤说明',
  '尺码对照表',
  '搭配示例',
  '上身模特图',
  '平铺图',
];

interface QaDraft {
  question: string;
  answer: string;
}

function emptyQa(): QaDraft {
  return { question: '', answer: '' };
}

function toTitleFromFile(name: string) {
  return name.replace(/\.[^.]+$/, '').slice(0, 64) || name;
}

interface KnowledgeDrawerProps {
  onClose: () => void;
  onSuccess: (info: { title: string; added: number; replacedOldCount: number }) => void;
  onToast?: (msg: string) => void;
}

function AddKnowledgeDrawer({ onClose, onSuccess, onToast }: KnowledgeDrawerProps) {
  const [format, setFormat] = useState<KnowledgeFormat>('qa');
  const [sourceType, setSourceType] = useState<KnowledgeSourceType>('rule');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [csv, setCsv] = useState('question,answer\n');
  const [json, setJson] = useState(
    '[\n  { "question": "...", "answer": "..." }\n]',
  );
  const [qaItems, setQaItems] = useState<QaDraft[]>([emptyQa()]);
  const [imageUrl, setImageUrl] = useState('');
  const [imageCaption, setImageCaption] = useState('');
  const [imageTagsRaw, setImageTagsRaw] = useState('');
  const [imageRelatedRaw, setImageRelatedRaw] = useState('');
  const [imageUploading, setImageUploading] = useState(false);

  // 商品档案向导
  const [prodId, setProdId] = useState('');
  const [prodName, setProdName] = useState('');
  const [prodDesc, setProdDesc] = useState('');
  const [prodAttributes, setProdAttributes] = useState<Array<{ label: string; value: string }>>([
    { label: '面料', value: '' },
    { label: '版型', value: '' },
    { label: '颜色', value: '' },
  ]);
  const [prodImages, setProdImages] = useState<Array<{ imageUrl: string; caption: string }>>([]);
  const [prodFaqs, setProdFaqs] = useState<QaDraft[]>([]);
  const [prodUploading, setProdUploading] = useState(false);
  const [captioningIndex, setCaptioningIndex] = useState<number | 'all' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [templates, setTemplates] = useState<KnowledgeTemplate[]>([]);

  useEffect(() => {
    fetchTemplates()
      .then((r) => setTemplates(r.templates))
      .catch(() => setTemplates([]));
  }, []);

  const activeHint = FORMAT_OPTIONS.find((f) => f.key === format)?.hint ?? '';
  const visibleTemplates = templates.filter((t) => {
    if (format === 'qa') return t.matchesFormat === 'csv' || t.matchesFormat === 'json';
    return t.matchesFormat === format;
  });

  const handleFileImport = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      const content = await file.text();
      if (!title) setTitle(toTitleFromFile(file.name));
      if (/\.csv$/i.test(file.name)) {
        setFormat('csv');
        setCsv(content);
      } else if (/\.json$/i.test(file.name)) {
        setFormat('json');
        setJson(content);
      } else if (/\.md$|\.markdown$/i.test(file.name)) {
        setFormat('markdown');
        setMarkdown(content);
      } else {
        setFormat('text');
        setText(content);
      }
      event.target.value = '';
    },
    [title],
  );

  const updateQa = (index: number, field: keyof QaDraft, value: string) => {
    setQaItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)),
    );
  };

  const addQaRow = () => setQaItems((prev) => [...prev, emptyQa()]);
  const removeQaRow = (index: number) =>
    setQaItems((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));

  const onImageFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setImageUploading(true);
    setError(undefined);
    try {
      const resp = await uploadMedia(file);
      setImageUrl(resp.url);
      if (!title) setTitle(toTitleFromFile(file.name));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImageUploading(false);
      event.target.value = '';
    }
  };

  const splitCsvInput = (raw: string) =>
    raw
      .split(/[,，;；\n]/)
      .map((item) => item.trim())
      .filter(Boolean);

  const captionSingle = async (idx: number) => {
    const item = prodImages[idx];
    if (!item?.imageUrl) return;
    setCaptioningIndex(idx);
    setError(undefined);
    onToast?.(`✨ 正在识别第 ${idx + 1} 张…`);
    try {
      const { caption } = await captionImage({
        imageUrl: item.imageUrl,
        productId: prodId.trim() || undefined,
        productName: prodName.trim() || undefined,
      });
      setProdImages((prev) => prev.map((img, i) => (i === idx ? { ...img, caption } : img)));
      onToast?.(`✓ 第 ${idx + 1} 张识别完成：${caption.slice(0, 28)}${caption.length > 28 ? '…' : ''}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`第 ${idx + 1} 张识别失败：${msg}`);
      onToast?.(`✗ 第 ${idx + 1} 张识别失败`);
    } finally {
      setCaptioningIndex(null);
    }
  };

  const captionAll = async () => {
    setCaptioningIndex('all');
    setError(undefined);
    onToast?.(`✨ 正在批量识别 ${prodImages.length} 张图片…`);
    let ok = 0;
    let fail = 0;
    try {
      // 串行跑避免把 chat model 并发打爆
      for (let i = 0; i < prodImages.length; i++) {
        const item = prodImages[i];
        if (!item?.imageUrl) continue;
        try {
          const { caption } = await captionImage({
            imageUrl: item.imageUrl,
            productId: prodId.trim() || undefined,
            productName: prodName.trim() || undefined,
          });
          setProdImages((prev) => prev.map((img, idx) => (idx === i ? { ...img, caption } : img)));
          ok += 1;
        } catch (e) {
          console.warn('caption failed for index', i, e);
          fail += 1;
        }
      }
      onToast?.(`批量识别完成 · 成功 ${ok}${fail > 0 ? ` · 失败 ${fail}` : ''}`);
    } finally {
      setCaptioningIndex(null);
    }
  };

  const onProdImages = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    setProdUploading(true);
    setError(undefined);
    const startIdx = prodImages.length;
    try {
      const results = await Promise.all(
        files.map((f) => uploadMedia(f).then((r) => ({ url: r.url, name: f.name }))),
      );
      const newItems = results.map((r) => ({ imageUrl: r.url, caption: '' }));
      setProdImages((prev) => [...prev, ...newItems]);

      // 新上传的图逐张自动识别 caption（异步；失败不打断，用户可手写或手点重试）
      setCaptioningIndex('all');
      (async () => {
        try {
          for (let i = 0; i < results.length; i++) {
            const globalIdx = startIdx + i;
            try {
              const { caption } = await captionImage({
                imageUrl: results[i].url,
                productId: prodId.trim() || undefined,
                productName: prodName.trim() || undefined,
                hint: toTitleFromFile(results[i].name),
              });
              setProdImages((prev) =>
                prev.map((img, idx) => (idx === globalIdx ? { ...img, caption } : img)),
              );
            } catch {
              // 忽略单张失败
            }
          }
        } finally {
          setCaptioningIndex(null);
        }
      })();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProdUploading(false);
      event.target.value = '';
    }
  };
  const updateProdAttr = (i: number, field: 'label' | 'value', v: string) =>
    setProdAttributes((prev) => prev.map((a, idx) => (idx === i ? { ...a, [field]: v } : a)));
  const removeProdAttr = (i: number) =>
    setProdAttributes((prev) => prev.filter((_, idx) => idx !== i));
  const updateProdImageCaption = (i: number, v: string) =>
    setProdImages((prev) => prev.map((img, idx) => (idx === i ? { ...img, caption: v } : img)));
  const removeProdImage = (i: number) =>
    setProdImages((prev) => prev.filter((_, idx) => idx !== i));
  const updateProdFaq = (i: number, field: keyof QaDraft, v: string) =>
    setProdFaqs((prev) => prev.map((q, idx) => (idx === i ? { ...q, [field]: v } : q)));
  const removeProdFaq = (i: number) =>
    setProdFaqs((prev) => prev.filter((_, idx) => idx !== i));

  const productPreview = useMemo(() => {
    if (format !== 'product') return null;
    const attrs = prodAttributes.filter((a) => a.label.trim() && a.value.trim()).length;
    const imgs = prodImages.filter((i) => i.imageUrl && i.caption.trim()).length;
    const faqs = prodFaqs.filter((f) => f.question.trim() && f.answer.trim()).length;
    return { total: 1 + attrs + imgs + faqs, attrs, imgs, faqs };
  }, [format, prodAttributes, prodImages, prodFaqs]);

  const onSubmit = async () => {
    setError(undefined);
    if (format !== 'product' && !title.trim()) {
      setError('请填写知识标题（同标题上传会整段替换旧数据）');
      return;
    }
    setSubmitting(true);
    try {
      let payload;
      if (format === 'product') {
        if (!prodId.trim()) throw new Error('请填写商品编号');
        if (!prodName.trim()) throw new Error('请填写商品名称');
        const validAttrs = prodAttributes
          .map((a) => ({ label: a.label.trim(), value: a.value.trim() }))
          .filter((a) => a.label && a.value);
        const validImages = prodImages
          .map((img) => ({ imageUrl: img.imageUrl, caption: img.caption.trim() }))
          .filter((img) => img.imageUrl && img.caption);
        const validFaqs = prodFaqs
          .map((f) => ({ question: f.question.trim(), answer: f.answer.trim() }))
          .filter((f) => f.question && f.answer);
        payload = {
          format: 'product' as const,
          productId: prodId.trim(),
          name: prodName.trim(),
          description: prodDesc.trim() || undefined,
          attributes: validAttrs,
          images: validImages,
          faqs: validFaqs,
        };
      } else if (format === 'text') {
        if (!text.trim()) throw new Error('纯文本内容不能为空');
        payload = { format, title: title.trim(), sourceType, text: text.trim() };
      } else if (format === 'markdown') {
        if (!markdown.trim()) throw new Error('Markdown 内容不能为空');
        payload = { format, title: title.trim(), sourceType, content: markdown };
      } else if (format === 'csv') {
        if (!csv.trim()) throw new Error('CSV 内容不能为空');
        payload = { format, title: title.trim(), sourceType, csv };
      } else if (format === 'json') {
        if (!json.trim()) throw new Error('JSON 内容不能为空');
        try {
          JSON.parse(json);
        } catch {
          throw new Error('JSON 格式非法，请检查引号和逗号');
        }
        payload = { format, title: title.trim(), sourceType, content: json };
      } else if (format === 'image') {
        if (!imageUrl) throw new Error('请先上传图片');
        if (!imageCaption.trim()) throw new Error('请填写图片说明（检索的核心文本）');
        payload = {
          format: 'image' as const,
          title: title.trim(),
          sourceType,
          imageUrl,
          caption: imageCaption.trim(),
          tags: splitCsvInput(imageTagsRaw),
          relatedQuestions: splitCsvInput(imageRelatedRaw),
        };
      } else {
        const valid = qaItems
          .map((item) => ({ question: item.question.trim(), answer: item.answer.trim() }))
          .filter((item) => item.question && item.answer);
        if (valid.length === 0) throw new Error('至少填一组完整的问答');
        payload = { format: 'qa' as const, title: title.trim(), sourceType, items: valid };
      }
      const result = await addKnowledge(payload);
      onSuccess({
        title: result.title,
        added: result.added,
        replacedOldCount: result.replacedOldCount,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="kb-drawer-overlay" onClick={onClose}>
      <div className="kb-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="kb-drawer-head">
          <h2>新增知识</h2>
          <button type="button" className="btn-ghost" onClick={onClose}>
            ✕ 关闭
          </button>
        </div>

        {format !== 'product' && (
          <div className="kb-form-row">
            <label>来源类型</label>
            <div className="chip-row">
              {(['rule', 'history', 'product'] as KnowledgeSourceType[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`chip ${sourceType === key ? 'active' : ''}`}
                  onClick={() => setSourceType(key)}
                  style={
                    sourceType === key
                      ? { borderColor: SOURCE_TYPE_COLOR[key], color: SOURCE_TYPE_COLOR[key] }
                      : undefined
                  }
                >
                  {SOURCE_TYPE_LABEL[key]}
                </button>
              ))}
            </div>
          </div>
        )}
        {format === 'product' && (
          <div className="kb-form-row">
            <label>来源类型</label>
            <div className="kb-locked-chip">🔒 商品（product · 商品档案向导会自动归档到这里）</div>
          </div>
        )}

        <div className="kb-form-row">
          <label>录入格式</label>
          <div className="chip-row">
            {FORMAT_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                className={`chip ${format === opt.key ? 'active' : ''}`}
                onClick={() => setFormat(opt.key)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="kb-hint">{activeHint}</div>
        </div>

        {visibleTemplates.length > 0 && (
          <div className="kb-form-row">
            <label>📥 下载模板 · 按模板填写后导入可最大化召回命中率</label>
            <div className="kb-template-grid">
              {visibleTemplates.map((t) => (
                <a
                  key={t.key}
                  className="kb-template-card"
                  href={t.downloadUrl}
                  download={t.downloadAs}
                >
                  <div className="kb-template-head">
                    <span className="kb-template-label">{t.label}</span>
                    <span className="kb-template-dl">⬇</span>
                  </div>
                  <div className="kb-template-desc">{t.description}</div>
                  <div className="kb-template-file mono">{t.downloadAs}</div>
                </a>
              ))}
            </div>
          </div>
        )}

        <details className="kb-best-practice">
          <summary>📘 知识录入最佳实践（点开查看）</summary>
          <ul>
            <li><b>首选 Q&A 格式：</b> 一条问答 = 一个向量块，粒度最细，检索命中率远高于段落。</li>
            <li><b>答案自包含：</b> 每条答案单独读得懂，不用"见上文/下述"这类代词。</li>
            <li><b>长度 60–250 字：</b> 太短语义不够，太长会被切块切散。</li>
            <li><b>包含具体实体：</b> 商品 ID、金额、日期、电话等关键词能显著提升 embedding 精度。</li>
            <li><b>同义问法多条录入：</b> "怎么退货" / "能退吗" / "退货流程" 可以并列录入，同一答案复用。</li>
            <li><b>来源类型归档正确：</b> 规则政策 → rule，商品档案 → product，客服积累问答 → history。</li>
            <li><b>同标题覆盖：</b> 相同 title 重复提交会覆盖旧版本，可以作为知识迭代机制。</li>
          </ul>
        </details>

        {format !== 'product' && (
          <>
            <div className="kb-form-row">
              <label>标题 · Title</label>
              <input
                className="kb-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例如：西装租赁-常见问题"
              />
              <div className="kb-hint">相同标题再次提交会覆盖旧数据，作为同一份知识的不同版本</div>
            </div>

            <div className="kb-form-row kb-file-row">
              <label>或导入文件</label>
              <label className="kb-file-btn">
                <input type="file" accept=".txt,.md,.markdown,.csv,.json" onChange={handleFileImport} />
                📂 选择 .txt / .md / .csv / .json
              </label>
            </div>
          </>
        )}

        {format === 'product' && (
          <>
            <div className="kb-product-section">
              <div className="kb-product-section-title">1️⃣ 商品基本信息</div>
              <div className="kb-product-grid-2">
                <div className="kb-form-row">
                  <label>商品编号 · productId</label>
                  <input
                    className="kb-input"
                    value={prodId}
                    onChange={(e) => setProdId(e.target.value)}
                    placeholder="例如：SUIT-001"
                  />
                </div>
                <div className="kb-form-row">
                  <label>商品名称 · name</label>
                  <input
                    className="kb-input"
                    value={prodName}
                    onChange={(e) => setProdName(e.target.value)}
                    placeholder="例如：黑色双排扣西装"
                  />
                </div>
              </div>
              <div className="kb-form-row">
                <label>一句话介绍（可选）</label>
                <textarea
                  className="kb-input kb-textarea"
                  rows={3}
                  value={prodDesc}
                  onChange={(e) => setProdDesc(e.target.value)}
                  placeholder="定位、版型、面料、适用场景等核心卖点。会进入概览 chunk。"
                />
              </div>
            </div>

            <div className="kb-product-section">
              <div className="kb-product-section-title">
                2️⃣ 核心属性
                <span className="kb-hint" style={{ marginLeft: 8 }}>
                  每一条会自动展开成一条问答 chunk（"XX 的{'{'}属性{'}'}是什么？"），命中率最高
                </span>
              </div>
              <div className="kb-attr-list">
                {prodAttributes.map((attr, i) => (
                  <div key={i} className="kb-attr-row">
                    <input
                      className="kb-input kb-attr-label"
                      value={attr.label}
                      onChange={(e) => updateProdAttr(i, 'label', e.target.value)}
                      placeholder="属性名（面料/版型/颜色/尺码/材质…）"
                    />
                    <input
                      className="kb-input kb-attr-value"
                      value={attr.value}
                      onChange={(e) => updateProdAttr(i, 'value', e.target.value)}
                      placeholder="属性值"
                    />
                    <button
                      type="button"
                      className="btn-ghost kb-qa-del"
                      onClick={() => removeProdAttr(i)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setProdAttributes((prev) => [...prev, { label: '', value: '' }])}
              >
                + 增加一条属性
              </button>
            </div>

            <div className="kb-product-section">
              <div className="kb-product-section-title">
                3️⃣ 商品图片（可多选）
                <span className="kb-hint" style={{ marginLeft: 8 }}>
                  每张图 = 一条 image chunk。caption 是检索入口，务必填写
                </span>
              </div>
              <div className="kb-assoc-banner">
                <span className="kb-assoc-icon">🔗</span>
                <span>
                  下列图片会自动归属到
                  <b className="kb-assoc-ref">
                    {prodId.trim() || prodName.trim()
                      ? `${prodId.trim() || '(未填编号)'} · ${prodName.trim() || '(未填名称)'}`
                      : '(请先填商品编号和名称)'}
                  </b>
                  · 向量化前会自动给 caption 加前缀，并把商品编号/名称写进 tags
                </span>
              </div>
              <div className="kb-image-bar">
                <label className="kb-file-btn kb-image-dropzone">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                    multiple
                    onChange={onProdImages}
                    disabled={prodUploading}
                  />
                  {prodUploading
                    ? '⏳ 上传中…'
                    : `🖼 选择一张或多张图片（已上传 ${prodImages.length} 张）`}
                </label>
                {prodImages.length > 0 && (
                  <button
                    type="button"
                    className="kb-primary"
                    onClick={captionAll}
                    disabled={captioningIndex !== null}
                    title="调用 vision 模型批量识别图片内容，生成 caption 草稿"
                  >
                    {captioningIndex === 'all' ? '⏳ 识别中…' : '✨ 智能识别全部图片'}
                  </button>
                )}
              </div>
              {prodImages.length > 0 && (
                <div className="kb-hint">
                  上传后系统会自动调 vision 模型识别每张图（正面/背面/细节/尺码表…），
                  识别结果可直接编辑；识别失败也可点单张「✨ 重试」或手动写 caption。
                </div>
              )}
              {prodImages.length > 0 && (
                <div className="kb-prod-image-grid">
                  {prodImages.map((img, i) => {
                    const busy = captioningIndex === i || captioningIndex === 'all';
                    const raw = img.caption.trim();
                    const name = prodName.trim();
                    const id = prodId.trim();
                    const finalCaption =
                      raw && (raw.includes(name) || raw.includes(id))
                        ? raw
                        : name || id
                          ? `${name || ''}${name && id ? '（' + id + '）' : id ? id : ''} · ${raw || '（待填）'}`
                          : raw || '（待填）';
                    return (
                      <div key={i} className="kb-prod-image-tile">
                        <div className="kb-tile-index">#{i + 1}</div>
                        <img src={img.imageUrl} alt={img.caption || `img-${i}`} />
                        <input
                          className="kb-input"
                          value={img.caption}
                          onChange={(e) => updateProdImageCaption(i, e.target.value)}
                          placeholder={busy ? '识别中…' : '点 ✨ 识别 / 或手动写 caption'}
                          disabled={busy}
                        />
                        {(name || id) && raw && (
                          <div className="kb-tile-preview" title="写入向量库时的完整 caption">
                            <span className="kb-tile-preview-tag">存入时</span>
                            <span className="kb-tile-preview-text">{finalCaption}</span>
                          </div>
                        )}
                        <div className="kb-preset-chips">
                          {CAPTION_PRESETS.slice(0, 6).map((p) => (
                            <button
                              key={p}
                              type="button"
                              className="kb-preset-chip"
                              onClick={() => updateProdImageCaption(i, p)}
                              title="一键填入常用 caption"
                            >
                              {p}
                            </button>
                          ))}
                        </div>
                        <details className="kb-preset-more">
                          <summary>更多预设…</summary>
                          <div className="kb-preset-chips">
                            {CAPTION_PRESETS.slice(6).map((p) => (
                              <button
                                key={p}
                                type="button"
                                className="kb-preset-chip"
                                onClick={() => updateProdImageCaption(i, p)}
                              >
                                {p}
                              </button>
                            ))}
                          </div>
                        </details>
                        <div className="kb-prod-tile-actions">
                          <button
                            type="button"
                            className={busy ? 'kb-primary' : 'btn-ghost'}
                            onClick={() => captionSingle(i)}
                            disabled={busy}
                          >
                            {busy ? '⏳ 识别中…' : '✨ 智能识别'}
                          </button>
                          <button
                            type="button"
                            className="btn-ghost"
                            onClick={() => removeProdImage(i)}
                          >
                            🗑 移除
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="kb-product-section">
              <div className="kb-product-section-title">
                4️⃣ 补充问答（可选）
                <span className="kb-hint" style={{ marginLeft: 8 }}>
                  针对这件商品的典型问答，会作为独立 QA chunk
                </span>
              </div>
              {prodFaqs.map((item, i) => (
                <div key={i} className="kb-qa-row">
                  <div className="kb-qa-index">#{i + 1}</div>
                  <textarea
                    className="kb-input kb-qa-q"
                    value={item.question}
                    onChange={(e) => updateProdFaq(i, 'question', e.target.value)}
                    placeholder="问题 Question"
                    rows={2}
                  />
                  <textarea
                    className="kb-input kb-qa-a"
                    value={item.answer}
                    onChange={(e) => updateProdFaq(i, 'answer', e.target.value)}
                    placeholder="答案 Answer"
                    rows={2}
                  />
                  <button
                    type="button"
                    className="btn-ghost kb-qa-del"
                    onClick={() => removeProdFaq(i)}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setProdFaqs((prev) => [...prev, emptyQa()])}
              >
                + 加一条 FAQ
              </button>
            </div>

            {productPreview && (
              <div className="kb-product-preview">
                <span>📦 预计生成 <b>{productPreview.total}</b> 条 chunk</span>
                <span className="kb-hint">
                  1 概览 + {productPreview.attrs} 属性 Q&A + {productPreview.imgs} 图片 + {productPreview.faqs} FAQ
                </span>
              </div>
            )}
          </>
        )}

        {format === 'image' && (
          <>
            <div className="kb-form-row">
              <label>1️⃣ 上传图片</label>
              <div className="kb-image-upload">
                {imageUrl ? (
                  <div className="kb-image-preview">
                    <img src={imageUrl} alt={imageCaption || 'preview'} />
                    <div className="kb-image-meta">
                      <span className="mono">{imageUrl}</span>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => setImageUrl('')}
                      >
                        移除
                      </button>
                    </div>
                  </div>
                ) : (
                  <label className="kb-file-btn kb-image-dropzone">
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                      onChange={onImageFile}
                      disabled={imageUploading}
                    />
                    {imageUploading ? '⏳ 上传中…' : '🖼 选择图片 (PNG/JPG/WebP/GIF/SVG · ≤8MB)'}
                  </label>
                )}
              </div>
            </div>
            <div className="kb-form-row">
              <label>
                2️⃣ 图片说明（caption · 这段文字会被向量化用于检索）
                <span className="kb-hint" style={{ marginLeft: 8 }}>
                  最关键字段，越具体越好
                </span>
              </label>
              <textarea
                className="kb-input kb-textarea"
                rows={4}
                value={imageCaption}
                onChange={(e) => setImageCaption(e.target.value)}
                placeholder="例如：西装 SUIT-001 尺码对照表，标注身高 165-190cm 各档对应建议尺码 S/M/L/XL 以及胸围、肩宽。"
              />
            </div>
            <div className="kb-form-row">
              <label>3️⃣ 标签（可选 · 逗号分隔）</label>
              <input
                className="kb-input"
                value={imageTagsRaw}
                onChange={(e) => setImageTagsRaw(e.target.value)}
                placeholder="例如：尺码表, 西装, SUIT-001"
              />
            </div>
            <div className="kb-form-row">
              <label>4️⃣ 相关问题（可选 · 每行或用逗号分隔）</label>
              <textarea
                className="kb-input kb-textarea"
                rows={3}
                value={imageRelatedRaw}
                onChange={(e) => setImageRelatedRaw(e.target.value)}
                placeholder={'我身高 180 穿多大？\n能不能发个尺码对照表\n有没有图片看一下'}
              />
              <div className="kb-hint">
                把用户可能问的多种问法列进来，每种问法都会参与向量匹配，大幅提升召回
              </div>
            </div>
          </>
        )}

        {format === 'qa' && (
          <div className="kb-form-row">
            <label>问答对</label>
            <div className="kb-qa-list">
              {qaItems.map((item, i) => (
                <div key={i} className="kb-qa-row">
                  <div className="kb-qa-index">#{i + 1}</div>
                  <textarea
                    className="kb-input kb-qa-q"
                    value={item.question}
                    onChange={(e) => updateQa(i, 'question', e.target.value)}
                    placeholder="问题 Question"
                    rows={2}
                  />
                  <textarea
                    className="kb-input kb-qa-a"
                    value={item.answer}
                    onChange={(e) => updateQa(i, 'answer', e.target.value)}
                    placeholder="答案 Answer"
                    rows={2}
                  />
                  <button
                    type="button"
                    className="btn-ghost kb-qa-del"
                    onClick={() => removeQaRow(i)}
                    disabled={qaItems.length <= 1}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="btn-ghost" onClick={addQaRow}>
              + 再加一组
            </button>
          </div>
        )}

        {format === 'text' && (
          <div className="kb-form-row">
            <label>文本内容</label>
            <textarea
              className="kb-input kb-textarea"
              rows={10}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="粘贴一整段知识文本，系统会按 500 字左右自动切块并建立向量索引"
            />
          </div>
        )}

        {format === 'markdown' && (
          <div className="kb-form-row">
            <label>Markdown 内容</label>
            <textarea
              className="kb-input kb-textarea kb-mono"
              rows={12}
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              placeholder={'# 标题\n\n段落内容……\n\n- 列表项 1\n- 列表项 2'}
            />
          </div>
        )}

        {format === 'csv' && (
          <div className="kb-form-row">
            <label>CSV 内容（首行：question,answer）</label>
            <textarea
              className="kb-input kb-textarea kb-mono"
              rows={10}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
            />
          </div>
        )}

        {format === 'json' && (
          <div className="kb-form-row">
            <label>JSON 内容</label>
            <textarea
              className="kb-input kb-textarea kb-mono"
              rows={10}
              value={json}
              onChange={(e) => setJson(e.target.value)}
            />
            <div className="kb-hint">
              推荐格式：[{'{'}&quot;question&quot;: &quot;...&quot;, &quot;answer&quot;: &quot;...&quot;{'}'}] · 其它任意 JSON 会被序列化为文本切块
            </div>
          </div>
        )}

        {error && <div className="kb-error">{error}</div>}

        <div className="kb-drawer-actions">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button type="button" onClick={onSubmit} disabled={submitting}>
            {submitting ? '提交中…' : '✓ 写入知识库'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function KnowledgePage() {
  const [data, setData] = useState<KnowledgeListResponse | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [sourceType, setSourceType] = useState<KnowledgeSourceType | 'all'>('all');
  const [contentType, setContentType] = useState<KnowledgeContentType | 'all'>('all');
  const [titleFilter, setTitleFilter] = useState<string>('');
  const [showDrawer, setShowDrawer] = useState(false);
  const [toast, setToast] = useState<string | undefined>();
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetchKnowledge({
        page,
        limit,
        search: search || undefined,
        sourceType,
        contentType,
        title: titleFilter || undefined,
      });
      setData(resp);
      setError(undefined);
      setSelected({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [page, limit, search, sourceType, contentType, titleFilter]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(undefined), 3500);
    return () => clearTimeout(id);
  }, [toast]);

  const totalPages = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, Math.ceil(data.total / data.limit));
  }, [data]);

  const onApplySearch = () => {
    setSearch(searchInput);
    setPage(1);
  };

  const deleteOne = async (entry: KnowledgeEntry) => {
    if (!confirm(`确定删除这条知识块？\n标题：${entry.title} · #${entry.chunkIndex}`)) return;
    try {
      await deleteKnowledge({ pointIds: [entry.pointId] });
      setToast(`已删除 1 条`);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteByTitle = async (title: string) => {
    if (!confirm(`确定删除标题为「${title}」的全部知识块？该操作不可撤销。`)) return;
    try {
      const result = await deleteKnowledge({ title });
      setToast(`已按标题删除 ${result.deleted} 条`);
      if (titleFilter === title) setTitleFilter('');
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteSelected = async () => {
    const ids = Object.keys(selected).filter((k) => selected[k]);
    if (ids.length === 0) return;
    if (!confirm(`确定删除已选中的 ${ids.length} 条知识块？`)) return;
    try {
      const result = await deleteKnowledge({ pointIds: ids });
      setToast(`已删除 ${result.deleted} 条`);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const selectedCount = Object.values(selected).filter(Boolean).length;
  const allVisibleSelected = (data?.entries.length ?? 0) > 0 && data?.entries.every((e) => selected[e.pointId]);

  const toggleAllVisible = () => {
    if (!data) return;
    if (allVisibleSelected) {
      const next = { ...selected };
      for (const e of data.entries) delete next[e.pointId];
      setSelected(next);
    } else {
      const next = { ...selected };
      for (const e of data.entries) next[e.pointId] = true;
      setSelected(next);
    }
  };

  const stats = data?.stats;

  return (
    <div className="kb-page">
      <div className="kb-header">
        <div>
          <h2>知识库管理</h2>
          <div className="muted">
            查看、检索、新增与删除所有进入向量库的知识片段
          </div>
        </div>
        <div className="kb-header-actions">
          <button type="button" onClick={load} disabled={loading}>
            {loading ? '同步中…' : '⟳ 刷新'}
          </button>
          <button type="button" className="kb-primary" onClick={() => setShowDrawer(true)}>
            ＋ 新增知识
          </button>
        </div>
      </div>

      {stats && (
        <div className="kb-stats">
          <div className="kb-stat">
            <div className="kb-stat-label">独立条目</div>
            <div className="kb-stat-value">{stats.totalEntries}</div>
            <div className="kb-stat-sub">{stats.total} 个向量片段</div>
          </div>
          {(Object.keys(stats.bySourceType) as KnowledgeSourceType[]).map((k) => (
            <div className="kb-stat" key={k}>
              <div className="kb-stat-label" style={{ color: SOURCE_TYPE_COLOR[k] }}>
                {SOURCE_TYPE_LABEL[k]}
              </div>
              <div className="kb-stat-value">{stats.entriesBySourceType?.[k] ?? 0}</div>
              <div className="kb-stat-sub">{stats.bySourceType[k] ?? 0} 个片段</div>
            </div>
          ))}
          <div className="kb-stat">
            <div className="kb-stat-label">Q&A 片段</div>
            <div className="kb-stat-value">{stats.byContentType.qa ?? 0}</div>
            <div className="kb-stat-sub">contentType = qa</div>
          </div>
          <div className="kb-stat">
            <div className="kb-stat-label">文本片段</div>
            <div className="kb-stat-value">{stats.byContentType.text ?? 0}</div>
            <div className="kb-stat-sub">contentType = text</div>
          </div>
          <div className="kb-stat">
            <div className="kb-stat-label">图片片段</div>
            <div className="kb-stat-value">{stats.byContentType.image ?? 0}</div>
            <div className="kb-stat-sub">contentType = image</div>
          </div>
        </div>
      )}

      <div className="kb-toolbar">
        <div className="kb-search">
          <input
            className="kb-input"
            placeholder="🔍 按内容或标题搜索…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onApplySearch();
            }}
          />
          <button type="button" onClick={onApplySearch}>
            搜索
          </button>
          {search && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setSearch('');
                setSearchInput('');
                setPage(1);
              }}
            >
              清除
            </button>
          )}
        </div>

        <div className="chip-row">
          {(['all', 'rule', 'history', 'product'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={`chip ${sourceType === key ? 'active' : ''}`}
              onClick={() => {
                setSourceType(key);
                setPage(1);
              }}
            >
              {key === 'all' ? '全部来源' : SOURCE_TYPE_LABEL[key as KnowledgeSourceType]}
              <em>
                {key === 'all'
                  ? stats?.total ?? 0
                  : stats?.bySourceType[key as KnowledgeSourceType] ?? 0}
              </em>
            </button>
          ))}
        </div>

        <div className="chip-row">
          {(['all', 'qa', 'text', 'image'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={`chip ${contentType === key ? 'active' : ''}`}
              onClick={() => {
                setContentType(key);
                setPage(1);
              }}
            >
              {key === 'all' ? '全部类型' : CONTENT_TYPE_LABEL[key as KnowledgeContentType]}
              <em>
                {key === 'all'
                  ? stats?.total ?? 0
                  : stats?.byContentType[key as KnowledgeContentType] ?? 0}
              </em>
            </button>
          ))}
        </div>

        {stats && stats.byTitle.length > 0 && (
          <select
            className="kb-input kb-select"
            value={titleFilter}
            onChange={(e) => {
              setTitleFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">所有标题 ({stats.byTitle.length})</option>
            {stats.byTitle.map((t) => (
              <option key={t.title} value={t.title}>
                {t.title}（{t.count}）
              </option>
            ))}
          </select>
        )}
      </div>

      {selectedCount > 0 && (
        <div className="kb-selection-bar">
          <span>
            已选中 <b>{selectedCount}</b> 条
          </span>
          <button type="button" onClick={deleteSelected} className="kb-danger">
            🗑 批量删除
          </button>
          <button type="button" className="btn-ghost" onClick={() => setSelected({})}>
            取消选择
          </button>
        </div>
      )}

      {error && <div className="kb-error">加载失败：{error}</div>}

      <div className="kb-list">
        <div className="kb-list-head">
          <label className="kb-check-label">
            <input
              type="checkbox"
              checked={!!allVisibleSelected}
              onChange={toggleAllVisible}
            />
            全选本页
          </label>
          <span className="muted">
            第 {data?.page ?? 1} / {totalPages} 页 · 共 {data?.total ?? 0} 条
          </span>
        </div>

        {(data?.entries ?? []).map((entry) => (
          <div key={entry.pointId} className="kb-card">
            <div className="kb-card-head">
              <input
                type="checkbox"
                checked={!!selected[entry.pointId]}
                onChange={(e) =>
                  setSelected((prev) => ({ ...prev, [entry.pointId]: e.target.checked }))
                }
              />
              <span
                className="kb-tag"
                style={{
                  borderColor: SOURCE_TYPE_COLOR[entry.sourceType],
                  color: SOURCE_TYPE_COLOR[entry.sourceType],
                }}
              >
                {SOURCE_TYPE_LABEL[entry.sourceType]}
              </span>
              <span className="kb-tag kb-tag-dim">{CONTENT_TYPE_LABEL[entry.contentType]}</span>
              <button
                type="button"
                className="kb-title-link"
                onClick={() => {
                  setTitleFilter(entry.title);
                  setPage(1);
                }}
                title="按此标题筛选"
              >
                {entry.title}
              </button>
              <span className="muted">· chunk #{entry.chunkIndex}</span>
              <div className="kb-card-actions">
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => deleteByTitle(entry.title)}
                  title="删除此标题的所有片段"
                >
                  删除整份
                </button>
                <button
                  type="button"
                  className="kb-danger"
                  onClick={() => deleteOne(entry)}
                >
                  🗑
                </button>
              </div>
            </div>
            {entry.imageUrl ? (
              <div className="kb-card-image">
                <a href={entry.imageUrl} target="_blank" rel="noreferrer">
                  <img src={entry.imageUrl} alt={entry.caption ?? entry.title} />
                </a>
                <pre className="kb-card-text kb-card-text-compact">{entry.text}</pre>
              </div>
            ) : (
              <pre className="kb-card-text">{entry.text}</pre>
            )}
            <div className="kb-card-meta mono">
              {entry.chunkId} · {entry.pointId.slice(0, 8)}…
            </div>
          </div>
        ))}

        {!loading && (data?.entries.length ?? 0) === 0 && (
          <div className="detail-empty">没有匹配的知识片段。试试调整筛选或点击右上角新增。</div>
        )}
      </div>

      <div className="kb-pager">
        <button
          type="button"
          className="btn-ghost"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          ← 上一页
        </button>
        <span className="muted">
          第 {data?.page ?? 1} / {totalPages} 页
        </span>
        <button
          type="button"
          className="btn-ghost"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页 →
        </button>
      </div>

      {showDrawer && (
        <AddKnowledgeDrawer
          onClose={() => setShowDrawer(false)}
          onToast={(msg) => setToast(msg)}
          onSuccess={(info) => {
            setShowDrawer(false);
            setToast(
              info.replacedOldCount > 0
                ? `已覆盖同名旧知识（${info.replacedOldCount} 条），新增 ${info.added} 条`
                : `已写入 ${info.added} 条知识到「${info.title}」`,
            );
            load();
          }}
        />
      )}

      {toast && <div className="kb-toast">{toast}</div>}
    </div>
  );
}
