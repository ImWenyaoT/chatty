// 关键词触发的意图识别器。集中在一个文件，方便审视优先级和冲突。
// 非关键词触发的识别（如身高体重/档期结构化抽取）不属于这里。

export function isDeliveryQuestion(question: string) {
  const normalized = question.replace(/\s+/g, '');
  return /什么时候寄到|什么时间寄到|多久寄到|几号寄到|什么时候发货|什么时间发货|多久发货|几号发货|物流|快递/.test(normalized);
}

export function isBodyMeasurementRecallQuestion(question: string) {
  const normalized = question.replace(/\s+/g, '');
  return (
    normalized.includes('身高') && normalized.includes('体重') &&
    (normalized.includes('多少') || normalized.includes('来着') || normalized.includes('记得') || normalized.includes('几'))
  );
}

export function isSimpleConfirmation(question: string) {
  const normalized = question.replace(/\s+/g, '').trim();
  return ['是', '是的', '对', '对的', '嗯', '嗯嗯', '好的', '好', '没错'].includes(normalized);
}

export function isPendingBodyMeasurementConfirmation(lastAssistantMessage?: string) {
  if (!lastAssistantMessage) return false;
  return (
    lastAssistantMessage.includes('我先帮您记下') &&
    lastAssistantMessage.includes('身高') &&
    lastAssistantMessage.includes('体重')
  );
}

export function isPendingRentalPeriodConfirmation(lastAssistantMessage?: string) {
  if (!lastAssistantMessage) return false;
  return lastAssistantMessage.includes('先帮您记下档期') || lastAssistantMessage.includes('先帮您把档期改成');
}

export function isGreetingQuestion(question: string) {
  const normalized = question.replace(/\s+/g, '').trim();
  return ['在吗', '在不在', '有人吗', '你好', '您好', '哈喽', 'hi', 'hello'].includes(normalized.toLowerCase());
}

export function isReadyToOrderReply(text: string) {
  return text.includes('直接下单填写') || text.includes('现在就可以直接下单');
}

export function isGenericRentIntent(question: string) {
  const normalized = question.replace(/\s+/g, '');
  return /我想租衣服|想租衣服|租衣服|想租个衣服|我想租个衣服/.test(normalized);
}

// "有哪些款式 / 都有什么款 / 都卖什么 / 有几款"——用户在问商品清单，
// 不是在指定具体商品，也不是在给档期，绝对不能被档期追问截胡
export function isCatalogListQuestion(question: string) {
  const normalized = question.replace(/\s+/g, '');
  if (/有哪些款|都有哪些款|有什么款|都有什么款|什么款式|哪些款式|有哪几款|几款可选|几款能租|几种款式/.test(normalized)) {
    return true;
  }
  // "有哪些/都有什么/卖什么/有什么" + 款式/款/商品/衣服 任一组合
  return /(有|卖|都有|都卖|有什么|都有什么|有哪些|都有哪些).{0,6}(款式|款|商品|衣服|西装|礼服|样式|选择|可选)/.test(normalized);
}

// 用户在要图片/照片/实拍图/款式图/效果图——图片由 imageReferences 前端卡片自动发送，
// 客服只需要一句简短确认话语，绝对不要借机又去追档期，否则用户会觉得"我要图你发档期"
export function isMediaRequestQuestion(question: string) {
  const normalized = question.replace(/\s+/g, '');
  // "发我照片 / 照片发我 / 来张图 / 给我看图 / 有图吗 / 看一下实拍 / 效果图发我"
  return (
    /(照片|图片|实拍|样图|效果图|款式图|细节图|上身图|模特图).{0,3}(发我|发过来|给我|来一张|来看看|看一下|看看|有没有|有吗|有嘛|瞅瞅)/.test(normalized) ||
    /(发我|给我|来|来一?张|来看看|看一下|看看|有没有|有).{0,3}(照片|图片|图|实拍|样图|效果图|款式图|细节图|上身图)/.test(normalized)
  );
}

export function isRentalHowToQuestion(question: string) {
  const normalized = question.replace(/\s+/g, '');
  return /怎么租|如何租|租赁流程|怎么下单|怎么拍|租衣服怎么租/.test(normalized);
}

export function isOrderQuestion(question: string) {
  const normalized = question.replace(/\s+/g, '');
  return /下单|拍下|能买吗|可以租吗|能下单吗|可以下单吗/.test(normalized);
}

export function isPriceQuestion(question: string) {
  const normalized = question.replace(/\s+/g, '');
  return /价格|多少钱|租金|费用/.test(normalized);
}

// 用户在问"尺码政策"——比如"可以选尺码吗 / 尺码怎么选 / 怎么挑尺码 / 尺码不合适怎么办 / 能换码吗"。
// 这类问题需要正面回答尺码规则，而不是把客户推去问档期/身高体重。
// 注意要排除"我穿 L 码"之类陈述句，这种是客户在告知信息（走 follow_flow）。
export function isSizeQuestion(question: string) {
  const normalized = question.replace(/\s+/g, '');
  if (!/尺码|尺寸|码数|大小|码/.test(normalized)) return false;
  // 询问语气 / 政策类问句
  if (/(?:可以|能|能不能|可不可以|怎么|如何|怎样|要怎么|怎么样|有没有|是否).{0,4}(?:选|挑|推荐|定|确认|换|改|决定|配|看|对|知道|测|量).{0,4}(?:尺码|尺寸|码|大小)/.test(normalized)) {
    return true;
  }
  if (/(?:尺码|尺寸|码|大小).{0,6}(?:怎么|如何|怎样|可以|能|不合适|不合身|有问题|偏[大小]|偏码|换|改|测|量|定)/.test(normalized)) {
    return true;
  }
  // "选尺码""挑尺码""定尺码"短句
  if (/^(?:选|挑|定|测|量)(?:尺码|尺寸|码|大小)[?？]?$/.test(normalized)) {
    return true;
  }
  return false;
}

export function looksLikeRentalPeriodQuestion(question: string) {
  const normalized = question.replace(/\s+/g, '');
  return /年|月|日|号|档期|租赁时间|开始时间|结束时间|起租|归还|到|至|用/.test(normalized);
}

export function isCurrentLinkProductQuestion(question: string) {
  const normalized = question.replace(/\s+/g, '');
  return /当前的链接商品|当前链接商品|就是这款|就是当前这款|就是链接这款|链接这款|当前这个链接/.test(normalized);
}

// 用户示意"没听懂"/请求澄清。优先级最高，在所有业务分支之前处理。
export function isRepairQuestion(question: string) {
  const normalized = question.replace(/\s+/g, '').trim();
  if (normalized.length === 0) return false;
  if (['?', '？', '??', '？？'].includes(normalized)) return true;
  return /没听懂|啥意思|什么意思|不明白|再说一遍|再说一次|没看懂|没太明白|听不懂/.test(normalized);
}
