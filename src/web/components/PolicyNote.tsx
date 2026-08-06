/** 一段有知识检索依据的政策说明。混合请求里的知识那半段。 */
export default function PolicyNote({ text }: { text: string }) {
  return <p className="policy-note">{text}</p>;
}
