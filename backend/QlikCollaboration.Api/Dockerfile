FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build

WORKDIR /src

COPY backend/QlikCollaboration.Api/QlikCollaboration.Api.csproj backend/QlikCollaboration.Api/
COPY database/ database/

WORKDIR /src/backend/QlikCollaboration.Api

RUN dotnet restore

COPY backend/QlikCollaboration.Api/ .

RUN dotnet publish -c Release -o /app --no-restore


FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime

WORKDIR /app

COPY --from=build /app .

RUN mkdir -p /data/uploads && chown -R app:app /data

ENV ASPNETCORE_URLS=http://+:5000 \
    Storage__AttachmentsPath=/data/uploads \
    DOTNET_SYSTEM_GLOBALIZATION_PREDEFINED_CULTURES_ONLY=false

EXPOSE 5000

USER app

ENTRYPOINT ["dotnet", "QlikCollaboration.Api.dll"]