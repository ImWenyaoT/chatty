// Action → 自然语言文本。纯函数，没有 LLM 调用，没有副作用。
// 改话术就改这里；答案结构 / 规则不变。

import type { Action } from './actions.js';

function formatPrice(value?: number) {
  if (value === undefined) return '';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatPeriod(start?: string, end?: string) {
  if (!start && !end) return '';
  if (start && end && start !== end) return `${start} 到 ${end}`;
  return start || end || '';
}

function parseIsoDate(text?: string) {
  if (!text) return undefined;
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return undefined;
  const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function formatMonthDay(date: Date) {
  return `${date.getMonth() + 1}月${date.getDate()}号`;
}

export function renderAction(action: Action): string {
  switch (action.kind) {
    case 'greet':
      return '在呢，您说，我这边看着。';

    case 'repair': {
      if (action.hint) {
        return `不好意思，刚才说得不够清楚。${action.hint}，您看这样回我就行。`;
      }
      return '不好意思，刚才说得不够清楚。您告诉我具体想了解哪一块，我再给您讲一下。';
    }

    case 'rental_howto': {
      const pricing = action.dailyPrice !== undefined
        ? `这款按天租，首日 ${formatPrice(action.dailyPrice)} 元，续租一天 ${formatPrice(action.renewalDailyPrice)} 元。`
        : '我们这边按天租，第一天全价，续租半价。';
      const shipping = action.shippingPolicy ?? '寄出一般包邮，新疆、西藏等偏远地区除外。';
      if (action.productId) {
        return `${pricing}在途时间不算租期，比如您 28 号开始使用、29 号结束，这边按 1 天算。${shipping}您把开始使用日期、结束日期和身高体重发我，这边先帮您看尺码和档期。`;
      }
      return `${pricing}在途时间不算租期，比如您 28 号开始使用、29 号结束，这边按 1 天算。${shipping}您先把想租的款式或者商品编号发我，再帮您看价格和档期。`;
    }

    case 'current_link_confirm': {
      const label = action.productText ?? action.productId ?? '这款';
      const priceText = action.dailyPrice !== undefined
        ? `首日 ${formatPrice(action.dailyPrice)} 元，续租每天 ${formatPrice(action.renewalDailyPrice)} 元，在途不算租期。`
        : '';
      return [
        `好，当前链接这款就是 ${label}，我先给您对上了。`,
        '您把档期（哪天用、哪天归还）、身高、体重发我，顺序不限；数量默认 1 件，要多件麻烦说一声。',
        priceText,
      ].filter(Boolean).join(' ');
    }

    case 'recall_body_empty':
      return '目前还没有记录到您的身高体重信息。您把身高和体重发我，我这边可以帮您记一下。';

    case 'recall_body_ambiguous': {
      const text = action.labels.length ? action.labels.join('、') : '其中一位';
      return `这边记录了多位的体型信息，您要确认的是${text}里的哪一位？`;
    }

    case 'post_order_delivery': {
      if (action.needsHandoff) {
        return '这个时间已经有点近了，我这边得再跟快递那边确认一下，确认好了马上回您。';
      }
      if (!action.rentalStartDate) {
        return '寄出时间这边得先看您的使用日期，您把开始使用那天发我，我马上帮您看。';
      }
      const startDate = parseIsoDate(action.rentalStartDate);
      if (startDate) {
        const deliveryDate = new Date(startDate);
        deliveryDate.setDate(deliveryDate.getDate() - 1);
        return `正常的话我们会提前一天给您寄到，按您这个时间看，一般是 ${formatMonthDay(deliveryDate)} 左右送到。`;
      }
      return '正常我们会提前一天给您寄到，您的开始使用日期前一天左右送到。';
    }

    case 'post_order_followup':
      return '您这边已经下单成功了，后续有物流或使用问题随时说一声，我这边继续帮您盯着。';

    case 'quote_price': {
      const priceText = action.dailyPrice !== undefined
        ? `这款第一天 ${formatPrice(action.dailyPrice)} 元，续租一天 ${formatPrice(action.renewalDailyPrice)} 元，在途不算租期。${action.shippingPolicy ?? ''}`
        : '这边是第一天全价，续租半价，在途不算租期。';
      return action.nextPrompt ? `${priceText} ${action.nextPrompt}`.trim() : priceText.trim();
    }

    case 'ask_product':
      return '亲，您先把想租的款式、颜色或者商品编号发我，我先帮您把具体商品对上，这样才能继续给您看尺码和档期。';

    case 'ask_period': {
      const productText = action.productText ? `"${action.productText}"` : '当前这款';
      // 缺什么就一起问，不强求顺序——先档期再身高体重 vs 反过来都没区别
      const missing: string[] = ['档期（哪天用、哪天归还）'];
      if (action.missingBody) missing.push('身高、体重');
      if (action.missingQuantity) missing.push('数量（默认 1 件）');
      const tail = missing.length > 1
        ? `${missing.join('、')}发我，顺序不限，凑齐了我这边一次性帮您对尺码和档期`
        : `${missing[0]}发我，我先帮您确认这个时间段能不能排上`;
      return `${productText}这边先给您记着了。您把${tail}，在途时间不算租期。`;
    }

    case 'ask_body': {
      const dateText = formatPeriod(action.startDate, action.endDate);
      const datePrefix = dateText ? `好，${dateText}这边先给您记上了。` : '好，';
      const hasHeight = action.knownHeightCm !== undefined;
      const hasWeight = action.knownWeightKg !== undefined;
      const missing: string[] = [];
      if (!hasHeight && !hasWeight) missing.push('身高、体重');
      else if (!hasHeight) missing.push('身高');
      else if (!hasWeight) missing.push('体重');
      if (action.missingPeriod) missing.push('档期（哪天用、哪天归还）');
      if (action.missingQuantity) missing.push('数量（默认 1 件）');
      const known: string[] = [];
      if (hasHeight) known.push(`身高 ${action.knownHeightCm}cm`);
      if (hasWeight) known.push(`体重 ${action.knownWeightKg}kg`);
      const knownPrefix = known.length ? `${known.join('，')}先记下。` : '';
      if (missing.length === 0) {
        return `${datePrefix}${knownPrefix}信息齐了，我马上帮您对尺码。`;
      }
      const joiner = missing.length > 1
        ? `您把${missing.join('、')}发我（顺序不限），凑齐了我这边一次性帮您对尺码`
        : `您再把${missing[0]}发我，我马上帮您对尺码`;
      return `${datePrefix}${knownPrefix}${joiner}。`;
    }

    case 'confirm_body_anomaly': {
      if (action.suspicion === 'weight_too_high' && action.weightKg !== undefined) {
        const jinToKg = (action.weightKg / 2).toFixed(0);
        return `${action.weightKg}kg 这个我和您确认下，您是想说身高 ${action.weightKg}cm，还是体重 ${action.weightKg} 斤（差不多 ${jinToKg}kg）？我按您确认的继续。`;
      }
      if (action.suspicion === 'height_too_high' && action.heightCm !== undefined) {
        return `身高 ${action.heightCm}cm 这个我再和您对下，是不是笔误呀？常见身高一般在 150-200cm 之间，您再发一下准确的数。`;
      }
      if (action.suspicion === 'height_too_low' && action.heightCm !== undefined) {
        return `身高 ${action.heightCm}cm 这个我再和您对下，是不是把米写成了？比如 1.75m，麻烦按 cm 发下，例如 175cm。`;
      }
      return '这个数字我再和您确认下，您再发一遍或者补充一下单位？';
    }

    case 'ack_body_measurement': {
      const parts: string[] = [];
      if (action.heightCm !== undefined) parts.push(`身高${action.heightCm}cm`);
      if (action.weightKg !== undefined) parts.push(`体重${action.weightKg}kg`);
      if (parts.length === 0) {
        return '这边还没识别到完整体型信息，您可以直接发身高和体重给我。';
      }
      if (action.isUpdating) return `好，这边先帮您把${parts.join('，')}更新了。`;
      if (action.inferredUnit === 'kg') return `好，您这边是${parts.join('，')}，我先给您记上。`;
      return `好，这边先记下，${parts.join('，')}。`;
    }

    case 'ack_rental_period': {
      const start = action.startDate;
      const end = action.endDate;
      if (!start && !end) return '这边还没识别到完整档期，您可以直接把开始和结束日期发我。';
      if (action.isUpdating) {
        if (start && end) return `好，这边先帮您把时间改成 ${start} 到 ${end}。`;
        if (end) return `好，这边先帮您把归还时间改到 ${end}。`;
        return `好，这边先帮您把使用时间改到 ${start}。`;
      }
      if (start && end && start !== end) return `好，这边先记下，您是 ${start} 使用，${end} 归还。`;
      if (end && !start) return `好，这边先记下归还时间是 ${end}。`;
      return `好，这边先记下使用时间是 ${start || end}。`;
    }

    case 'confirm_size': {
      const note = action.note ? ` ${action.note}` : '';
      return `看您给的身高体重，这款您穿 ${action.size} 码更合适。${note}如果到手不合身，我们支持免费换码。`;
    }

    case 'confirm_review': {
      const productText = action.productText ? `商品是"${action.productText}"` : '商品信息';
      const sizeText = !action.size
        ? '尺码稍后复核'
        : action.size === '尺码待人工确认'
          ? '尺码我这边人工再帮您核对一次'
          : `尺码按 ${action.size} 码`;
      const periodText = formatPeriod(action.startDate, action.endDate);
      const dateText = periodText ? `档期是 ${periodText}` : '档期信息';
      const qty = action.quantity ?? 1;
      const quantityText = action.quantityIsDefault
        ? `数量按默认 ${qty} 件（要多件麻烦说一声）`
        : `数量 ${qty} 件`;
      return `我先和您复核一下：${productText}，${dateText}，${sizeText}，${quantityText}。信息都对的话，回我"好的"/"对的"，我这边就继续帮您安排。`;
    }

    case 'guide_order': {
      const sizeText = action.size ? `${action.size} 码` : '合适尺码';
      const periodText = formatPeriod(action.startDate, action.endDate) || '您要的档期';
      const priceText = action.dailyPrice !== undefined ? `首日 ${formatPrice(action.dailyPrice)} 元，` : '';
      const qty = action.quantity ?? 1;
      const qtyClause = qty > 1 ? `数量 ${qty} 件，` : '';
      return `这边帮您看下来，${sizeText}更合适，${periodText}这个时间也能安排。${qtyClause}${priceText}您现在直接下单就行，租赁时间按 ${periodText} 填就可以。`;
    }

    case 'check_availability':
      return '好，这边继续帮您对一下这个尺码的档期和库存。';

    case 'answer_faq': {
      const text = action.text.trim();
      const follow = action.orchestrationFollowUp?.trim();
      if (!follow) return text;
      // 如果主答案已经包含 follow-up 关键语义（按去标点小写做宽松比较），就不重复
      const normalize = (s: string) => s.replace(/[\s，。！？,.!?、]/g, '').toLowerCase();
      const textNorm = normalize(text);
      const followNorm = normalize(follow);
      if (followNorm && (textNorm.includes(followNorm) || followNorm.includes(textNorm))) {
        return text;
      }
      return `${text}\n\n${follow}`;
    }

    case 'small_talk':
      return action.text.trim();

    case 'handoff':
      return action.text.trim();
  }
}

// 判断一个 action 是否涉及"下单引导"（用于追加跟进 follow-up 时去重）
export function isOrderActionKind(kind: Action['kind']) {
  return kind === 'guide_order' || kind === 'confirm_review' || kind === 'check_availability';
}
