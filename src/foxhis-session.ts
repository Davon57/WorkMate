export function isFoxhisLoginRedirect(response: Response): boolean {
  const location = response.headers.get("location") ?? "";
  return response.status >= 300 && response.status < 400 && /\/login\/?(?:[?#]|$)/i.test(location);
}

export function isFoxhisSessionExpired(response: Response): boolean {
  return response.status === 401 || isFoxhisLoginRedirect(response);
}

export function createFoxhisSession(
  login: () => Promise<void>,
  request: (path: string, init?: RequestInit) => Promise<Response>,
) {
  let session: Promise<void> | undefined;

  function signIn(): Promise<void> {
    session ??= login().catch((error) => {
      session = undefined;
      throw error;
    });
    return session;
  }

  return async function read(path: string, init?: RequestInit): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = signIn();
      await current;
      const response = await request(path, init);
      if (!isFoxhisSessionExpired(response)) return response;
      if (session === current) session = undefined;
      await response.body?.cancel();
    }
    throw new Error("FoxHIS 登录会话已失效，重新登录后仍无法读取");
  };
}
