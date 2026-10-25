import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "./lib/api";
import { ToastProvider } from "./components/ui";
import App from "./App";
import "./styles/app.css";

function loggedOut(error: unknown) {
  if (error instanceof ApiError && error.code === "not_authenticated") {
    void client.invalidateQueries({ queryKey: ["bootstrap"] });
  }
}

const client: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: loggedOut }),
  mutationCache: new MutationCache({ onError: loggedOut }),
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
