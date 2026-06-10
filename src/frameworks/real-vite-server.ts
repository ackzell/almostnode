export interface RealViteServerOptions {
  root: string;
  port: number;
}

export class RealViteServer {
  private getVite: () => any;
  private getHttp: () => any;
  private options: RealViteServerOptions;
  private viteServer: any = null;
  private httpServer: any = null;
  private _closed = false;

  constructor(
    getVite: () => any,
    getHttp: () => any,
    options: RealViteServerOptions,
  ) {
    this.getVite = getVite;
    this.getHttp = getHttp;
    this.options = options;
  }

  async start(): Promise<void> {
    const vite = this.getVite();

    this.viteServer = await vite.createServer({
      root: this.options.root,
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
      logLevel: 'silent',
    });

    const http = this.getHttp();

    const listener = (req: any, res: any) => {
      if (!this.viteServer) {
        res.statusCode = 503;
        res.end('Server not ready');
        return;
      }
      this.viteServer.middlewares(req, res, () => {
        res.statusCode = 404;
        res.end('Not found');
      });
    };

    this.httpServer = http.createServer(listener);

    return new Promise((resolve, reject) => {
      this.httpServer.listen(this.options.port, () => {
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    if (this.viteServer) {
      try {
        await this.viteServer.close();
      } catch {
      }
      this.viteServer = null;
    }

    if (this.httpServer) {
      await new Promise((resolve) => {
        this.httpServer.close(resolve);
      });
      this.httpServer = null;
    }
  }

  getViteServer(): any {
    return this.viteServer;
  }

  getPort(): number {
    return this.options.port;
  }

  getHttpServer(): any {
    return this.httpServer;
  }
}
