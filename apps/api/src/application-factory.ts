import { ChattyRunModule } from "./agent-runtime.js";
import {
  createHttpApplication,
  type HttpApplicationOptions,
} from "./http-application.js";
import { NativeRuntime } from "./runtime.js";

export function createDefaultHttpApplication(input: {
  databasePath: string;
  knowledgePath: string;
  customerIdentity?: HttpApplicationOptions["customerIdentity"];
  requestIdentity?: HttpApplicationOptions["requestIdentity"];
}) {
  let runtime: NativeRuntime | undefined;
  const nativeRuntimeFactory = () =>
    (runtime ??= new NativeRuntime(input.databasePath));
  let runModule: ChattyRunModule | undefined;

  return createHttpApplication({
    nativeRuntimeFactory,
    nativeRunFactory: () =>
      (runModule ??= new ChattyRunModule(nativeRuntimeFactory(), {
        knowledgePath: input.knowledgePath,
      })),
    customerIdentity: input.customerIdentity,
    requestIdentity: input.requestIdentity,
  });
}
