import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Trocas e Devoluções — DLY Lingerie",
  description: "Solicite a troca ou devolução do seu pedido DLY Lingerie de forma rápida e segura.",
};

export default function TrocaLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#faf8f9] text-slate-800 antialiased selection:bg-[#e47cbd] selection:text-white">
      {children}
    </div>
  );
}
