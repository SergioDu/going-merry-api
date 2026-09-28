import { describe, expect, it } from "vitest";

import { Processamentos } from "../../src/planilha/processamentos";

function relogio(inicio = 0) {
  let agora = inicio;

  return {
    agora: () => agora,
    avancar: (ms: number) => {
      agora += ms;
    },
  };
}

describe("Processamentos", () => {
  it("reports a sheet as being processed until it is finished", () => {
    const store = new Processamentos();

    store.iniciar("abc", 10);

    expect(store.consultar("abc")).toMatchObject({ id: "abc", status: "processando", total: 10 });
  });

  it("hands back the result once the sheet is finished", () => {
    const store = new Processamentos();
    store.iniciar("abc", 1);

    store.concluir("abc", { comErro: 0, cotacoes: 1, tempoMs: 5, linhas: [] });

    expect(store.consultar("abc")).toMatchObject({ status: "concluida", total: 1, cotacoes: 1, linhas: [] });
  });

  it("keeps the reason when processing fails", () => {
    const store = new Processamentos();
    store.iniciar("abc", 1);

    store.falhar("abc", "API de frete fora do ar");

    expect(store.consultar("abc")).toMatchObject({ status: "erro", mensagem: "API de frete fora do ar" });
  });

  it("knows nothing about a sheet it was never given", () => {
    expect(new Processamentos().consultar("nunca")).toBeUndefined();
  });

  it("tells whether an id is already taken", () => {
    const store = new Processamentos();
    store.iniciar("abc", 1);

    expect(store.existe("abc")).toBe(true);
    expect(store.existe("outro")).toBe(false);
  });

  // Nothing is persisted, so a result nobody came back for has to go away on its
  // own — otherwise every sheet ever sent stays in memory.
  it("forgets a sheet once it has been kept long enough", () => {
    const { agora, avancar } = relogio();
    const store = new Processamentos({ validadeMs: 1000, agora });
    store.iniciar("abc", 1);
    store.concluir("abc", { comErro: 0, cotacoes: 0, tempoMs: 0, linhas: [] });

    avancar(999);
    expect(store.consultar("abc")).toBeDefined();

    avancar(2);
    expect(store.consultar("abc")).toBeUndefined();
    expect(store.existe("abc")).toBe(false);
  });

  it("counts the time a result is kept from when it finished, not from when it started", () => {
    const { agora, avancar } = relogio();
    const store = new Processamentos({ validadeMs: 1000, agora });
    store.iniciar("abc", 1);

    avancar(5000);
    store.concluir("abc", { comErro: 0, cotacoes: 0, tempoMs: 0, linhas: [] });
    avancar(500);

    expect(store.consultar("abc")).toMatchObject({ status: "concluida" });
  });
});
