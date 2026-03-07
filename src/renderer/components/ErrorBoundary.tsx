import React from "react";

interface ErrorBoundaryState {
  error: Error | null;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fatal-screen">
          <div className="fatal-screen__panel">
            <h1>Renderer failed to load</h1>
            <p>TermBag hit a renderer error before the UI finished loading.</p>
            <pre>{this.state.error.stack ?? this.state.error.message}</pre>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
