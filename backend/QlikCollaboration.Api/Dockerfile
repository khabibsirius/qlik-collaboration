# Build stage — the SDK image is discarded, only the published output ships.
#
# The build context is the REPOSITORY ROOT, not this folder: the project embeds
# database/schema.sql so the running build always carries the schema it expects,
# and that file lives outside the project. Compose passes
#   context: .
#   dockerfile: backend/QlikCollaboration.Api/Dockerfile
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

# Restore first so a code-only change reuses the cached package layer.
COPY backend/QlikCollaboration.Api/QlikCollaboration.Api.csproj backend/QlikCollaboration.Api/
RUN dotnet restore backend/QlikCollaboration.Api/QlikCollaboration.Api.csproj

COPY backend/QlikCollaboration.Api/ backend/QlikCollaboration.Api/
COPY database/ database/
RUN dotnet publish backend/QlikCollaboration.Api/QlikCollaboration.Api.csproj \
        -c Release -o /app --no-restore

# Runtime stage.
# Debian-based (not -alpine) on purpose: it ships ICU, which keeps case-insensitive
# matching correct for Cyrillic user names. Alpine would save ~100 MB but runs in
# globalization-invariant mode.
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime

# curl is used by the container healthcheck (and is useful for diagnostics).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app .

# Attachments live outside the image — mount a volume here or files vanish on redeploy.
RUN mkdir -p /data/uploads && chown -R app:app /data

ENV ASPNETCORE_URLS=http://+:5000 \
    Storage__AttachmentsPath=/data/uploads \
    DOTNET_SYSTEM_GLOBALIZATION_PREDEFINED_CULTURES_ONLY=false

EXPOSE 5000
USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:5000/health || exit 1

ENTRYPOINT ["dotnet", "QlikCollaboration.Api.dll"]
