namespace QlikCollaboration.Api.Models;

public class Attachment
{
    public int Id { get; set; }
    public int CommentId { get; set; }
    public string FileName { get; set; } = "";
    public string ContentType { get; set; } = "";
    public long SizeBytes { get; set; }
    public DateTime UploadedAt { get; set; }
}
