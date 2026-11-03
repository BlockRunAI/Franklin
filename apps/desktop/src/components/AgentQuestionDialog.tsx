import { useEffect, useRef, useState } from "react";
import { useTryLang } from "../lib/i18n";
import type { AgentQuestion } from "../lib/wire";

const copy = {
  en: { title: "Franklin has a question", hint: "Choose an option or write your own answer.", answer: "Your answer", send: "Send answer", cancel: "Skip question" },
  zh: { title: "Franklin 需要你的回答", hint: "选择一个选项，或输入你自己的回答。", answer: "你的回答", send: "发送回答", cancel: "跳过问题" },
  es: { title: "Franklin tiene una pregunta", hint: "Elige una opción o escribe tu respuesta.", answer: "Tu respuesta", send: "Enviar respuesta", cancel: "Omitir pregunta" },
};

export function AgentQuestionDialog({ question, onAnswer }: { question: AgentQuestion; onAnswer: (answer: string) => void }) {
  const { lang } = useTryLang();
  const c = copy[lang];
  const [answer, setAnswer] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="try-mkt-modal agent-question" aria-labelledby="agent-question-title" onCancel={event => { event.preventDefault(); onAnswer(""); }}>
    <form onSubmit={event => { event.preventDefault(); if (answer.trim()) onAnswer(answer.trim()); }}>
      <h2 id="agent-question-title" className="try-mkt-modal-name">{c.title}</h2>
      <p className="try-mkt-modal-detail agent-question-text">{question.question}</p>
      <p className="try-mkt-modal-by">{c.hint}</p>
      <div className="agent-question-options">
        {question.options.map((option, index) => <button key={index} type="button" className="cloud-secondary" aria-pressed={answer === option} onClick={() => setAnswer(option)}>{option}</button>)}
      </div>
      <label className="agent-question-label" htmlFor="agent-question-answer">{c.answer}</label>
      <textarea id="agent-question-answer" className="agent-question-answer" value={answer} onChange={event => setAnswer(event.target.value)} maxLength={16_000} rows={4} />
      <div className="try-mkt-modal-foot">
        <button type="button" className="cloud-secondary" onClick={() => onAnswer("")}>{c.cancel}</button>
        <button type="submit" className="try-mkt-try" disabled={!answer.trim()}>{c.send}</button>
      </div>
    </form>
  </dialog>;
}
